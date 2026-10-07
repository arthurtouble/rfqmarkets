# Base mainnet deployment

Status 2026-10-07: the dev profile is deployed and unpaused on Base mainnet (proxy `0x6e67c66f955D88EBD6D69eD3343359651C6f45a1`, ProxyAdmin `0x488A3181DC988A663d48f696b8cb01e37FBa64B6`, caps 25 USDC per trade and 100 USDC per market). It runs the v1 code from before the contract review fixes; a fresh deploy is planned once the oracle work lands. Every mainnet transaction waits for an explicit go-ahead from the project owner.

There are two profiles:

- **Dev** (next): a development deployment on Base mainnet that replaces Base Sepolia for day-to-day testing, so real USDC and ETH can be used instead of faucet assets. One owner wallet controls everything directly: caps change immediately and upgrades land in a single transaction, with no Safe and no timelock. Caps are hard-limited by the tooling. It is planned for after the contract rewrite and bug fixes land.
- **Production** (later): Safes, a 72-hour timelock and canary caps. It can be a fresh deployment, or the dev proxy handed over in place with `dev-handover` (v1 has two-step governance transfer), keeping its address and balances.

## Dev profile

### What the owner must supply

1. **About 0.02 ETH on Base** sent to the owner address that `dev-identities` prints. That covers the deploy (~13M gas, ~0.00015 ETH at normal fees, ~0.007 ETH at a 0.5 gwei spike) and many upgrades (~11M gas, ~0.0001 ETH each).
2. **Some USDC on Base** for testing: the maker capital floor (100 USDC in the generated manifest) plus whatever test trades need.
3. **The oracle node signer addresses** (3 to 16, one per independent oracle node). The manifest threshold defaults to a majority; nodes keep their keys.
4. **A Base RPC URL.** A paid one (Alchemy, QuickNode) is better, but public `https://mainnet.base.org` works for a low-volume dev deployment.

`dev-identities` generates the owner, emergency and three approver keys into `.local-state/base-mainnet-dev/identities.json` (mode 0600, never committed) and writes a ready `dev-manifest.json` that uses their addresses. To use a wallet you already hold as owner instead, set `owner` in the manifest and pass its key as `RFQ_MAINNET_DEPLOYER_KEY`.

To run the dev profile from GitHub Actions with the UI and services hosted on Cloudflare instead of from a laptop, see [deploy/cloudflare/DEV-ENVIRONMENT.md](../../deploy/cloudflare/DEV-ENVIRONMENT.md).

### Dev caps

`validateDevManifest` refuses anything above 1,000 USDC per trade, 5,000 USDC net or 10,000 USDC gross per market, and a 50,000 USDC maker capital floor. The generated manifest uses 25 USDC per trade, 100 net, 200 gross and 150 per side, plus a 100 USDC maker floor. These caps bound trading exposure, not deposits: the contract is public, so anyone who finds it can deposit their own USDC and withdraw it again. Don't publicize the address.

### Commands

```bash
npm run dev-identities:base-mainnet -- SIGNER1,SIGNER2,SIGNER3   # once; prints the owner address to fund
npm run dev-preflight:base-mainnet -- .local-state/base-mainnet-dev/dev-manifest.json
npm run dev-deploy:base-mainnet -- .local-state/base-mainnet-dev/dev-manifest.json --unpause
npm run dev-verify:base-mainnet -- .local-state/base-mainnet-dev/dev-manifest.json
npm run dev-configure:base-mainnet -- MANIFEST [--unpause]  # after editing caps
npm run dev-upgrade:base-mainnet -- MANIFEST                # after contract changes
npm run dev-basescan:base-mainnet -- MANIFEST
npm run dev-handover:base-mainnet -- MANIFEST TIMELOCK GOVERNANCE_SAFE EMERGENCY_SAFE  # when going to production
```

`dev-deploy` deploys the same contracts as production (six libraries, implementation, `SignedPriceOracle`, proxy), then the owner binds the oracle with `setClearing(proxy)`. v1 initializes paused with the manifest caps and risk parameters already set, so `--unpause` is the only extra step. `dev-handover` also hands the oracle's ownership to the timelock (two-step, accepted in the same timelock batch as `acceptGovernance`). `dev-configure` re-applies edited caps (pause, set exposure and market caps, optionally unpause). `dev-upgrade` checks the new build's storage layout against the build-info snapshot taken at deploy (or at the last upgrade), deploys fresh libraries and a fresh implementation, and points the proxy at them with one `upgradeAndCall` transaction. Balances and positions stay in place, which the rehearsal checks. Each broadcasting command still requires the `RFQ_MAINNET_DEPLOY_CONFIRM` string it prints, so a stray shell can't send mainnet transactions by accident.

v1 storage lives in the ERC-7201 namespace `rfq.clearing.v1`. A change the validator rejects needs a fresh dev proxy (move `deployment.json` aside and run `dev-deploy` again) rather than an upgrade.

### Handing the dev proxy to production governance

1. Create the governance and emergency Safes, run `deploy:base-mainnet-timelock -- GOVERNANCE_SAFE`, and execute the renounce batch it writes.
2. `dev-handover` checks the timelock (delay, self-administration, owner holds no role), sets the emergency Safe as emergency council, nominates the timelock as governance, and transfers the ProxyAdmin to it. It writes `safe-batches/handover-1-schedule-accept.json` and `handover-2-execute-accept.json`.
3. The governance Safe schedules `acceptGovernance` now and executes it after 72 hours. Until then the owner key is still clearing governance, but upgrades already need the timelock.

Before relying on a handed-over proxy for real capital, lower or re-set caps through the timelock and remove the dev approver keys with `rotateApprovers`, since those keys were generated on a laptop.

# Production profile

## What gets deployed

| Order | Contract | Who deploys | Notes |
| --- | --- | --- | --- |
| 0a | Governance Safe | Owner, in the Safe app | 2-of-3 or stronger, hardware-wallet owners |
| 0b | Emergency Safe | Owner, in the Safe app | Different owners from the governance Safe |
| 0c | `RFQTimelock` | `deploy:base-mainnet-timelock` | OpenZeppelin `TimelockController`, 72 h delay. Governance Safe is proposer/executor and must renounce the bootstrap admin role |
| 1–5 | `RFQRiskMath`, `RFQLiquidation`, `RFQResolution`, `RFQSignatureVerifier`, `RFQSettlement` | `deploy:base-mainnet` | Linked libraries, deployed in dependency order; part of implementation authority |
| 6 | `RFQClearing` implementation | same | Constructor disables initializers |
| 7 | `SignedPriceOracle` | same | Owned by the timelock, with the manifest signers, majority threshold and consensus parameters. `setClearing(proxy)` is a recorded pending owner step that runs in the timelocked go-live batch, so the oracle refuses every report until go-live |
| 8 | `TransparentUpgradeableProxy` | same | Calls `initialize` paused with the manifest caps; creates a `ProxyAdmin` owned by the timelock |

Already on Base and only referenced: native USDC `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` (pinned in `mainnet-manifest.ts`). `RFQAuthorization` is not part of this deployment.

## What the owner must supply

1. **Governance Safe** on Base mainnet, at least 2-of-3, hardware-wallet owners. None of the testnet identities qualify.
2. **Emergency Safe** on Base mainnet, at least 2-of-3, with owners that cannot reach the emergency threshold through governance-Safe overlap. Preflight refuses overlapping control.
3. **Three approver signing addresses**, each generated independently (ideally one per host/provider). Only the addresses go in the manifest; keys never touch this repository.
4. **A fresh deployer EOA** funded with about **0.01 ETH** on Base. It ends with no role anywhere (verified), so it can be a single-use hot key. Supplied only through `RFQ_MAINNET_DEPLOYER_KEY` in an ignored env file.
5. **Two independent Base mainnet RPC URLs** (for example Alchemy and QuickNode). The second is used to cross-verify the deployment.
6. **Oracle node signer addresses** (`oracleSigners`, 3 to 16, distinct from every other role) and `oracleThreshold` (a strict majority). Optional `oracle` consensus parameters default to `maxDeviationBps` 50, `maxSkew` 5 s and the jump guard off (`maxJumpBps` 0, `jumpWindow` 0).
7. **Canary policy numbers**: maker capital floor, insurance, daily loss limit and per-market caps (see `deploy/base-mainnet/MANIFEST.example.json`). The maker capital floor is written into `initialize`, and trades fail until that much maker USDC is deposited.
8. **A Basescan API key** (Etherscan v2 key) to publish verified source.

## Cost

Measured in the rehearsal (`npm run rehearse:base-mainnet`):

| Transaction | Gas |
| --- | --- |
| RFQRiskMath | 2,056,041 |
| RFQLiquidation | 1,398,142 |
| RFQResolution | 1,591,829 |
| RFQSignatureVerifier | 634,828 |
| RFQSettlement | 1,555,089 |
| RFQClearing implementation | 4,838,294 |
| SignedPriceOracle | 2,286,697 |
| Proxy + initialize + ProxyAdmin | 1,222,498 |
| RFQTimelock | 1,381,354 |
| **Total** | **16,964,772** |

L2 execution at 0.01 gwei is about 0.00017 ETH; at a 0.5 gwei spike it is about 0.0085 ETH. Base also charges an L1 data fee for the init code, normally cents. Preflight prints the live estimate (including the L1 fee upper bound from the `GasPriceOracle` predeploy) and refuses to proceed unless the deployer holds twice the estimate. Two Safe creations and the launch batches are paid by the Safe owners and cost a few cents each.

## Procedure

Load an ignored env file first (`set -a; source ./base-mainnet.env; set +a`) holding `RFQ_BASE_MAINNET_RPC_URL`, `RFQ_BASE_MAINNET_SECONDARY_RPC_URL`, `RFQ_MAINNET_DEPLOYER_KEY` and later `RFQ_BASESCAN_API_KEY`. Outputs go to `.local-state/base-mainnet/` with mode 0600.

Every broadcasting command refuses to run until `RFQ_MAINNET_DEPLOY_CONFIRM` equals a string it prints, which binds the action to chain 8453, the deployer address and the candidate (or governance Safe for the timelock).

1. Create both Safes in the Safe app.
2. `npm run deploy:base-mainnet-timelock -- GOVERNANCE_SAFE`, then execute `safe-batches/0-renounce-timelock-admin.json` from the governance Safe (Transaction Builder, "Load batch").
3. Freeze the commit. Write the manifest outside the repository or under `.local-state/`, with `candidateHash` from `npm run candidate:base-mainnet`. Any change to tracked source changes the hash and invalidates the manifest.
4. `npm run preflight:base-mainnet -- MANIFEST.json`. It is read-only: it checks the chain ID, USDC decimals, both Safe thresholds and owner overlap, timelock delay and self-administration, that the deployer holds no role, and gas/balance.
5. `npm run deploy:base-mainnet -- MANIFEST.json --dormant` (or `--release-evidence EVIDENCE.json` once `release:check` passes). It deploys steps 1–8, waits two confirmations per transaction, and writes `deployment.json` plus two Safe batches. An interrupted run resumes from `deployment.partial.json`; a resumed oracle must be owned by governance and unbound. The proxy starts paused with the manifest caps, so no emergency step is needed.
6. `npm run verify:base-mainnet -- MANIFEST.json` runs the checks against both RPCs: implementation and library runtime bytecode equal the local build, proxy slots, ProxyAdmin owned by the timelock, every role, approvers, capital floor, oracle bytecode, owner, signers, threshold, consensus parameters and binding (or its recorded pending step), two markets with caps and risk parameters matching the manifest, timelock self-administration, and no deployer authority.
7. `npm run basescan:base-mainnet -- MANIFEST.json` publishes standard-JSON source for all nine contracts.
8. Execute `safe-batches/1-schedule-go-live.json` from the governance Safe. It schedules a timelocked `unpause`.
9. Execute `2-execute-go-live.json` after 72 hours and only once the approvers, keeper, hedger, indexer and monitoring are running against mainnet and the release checklist allows it. Until then the deployment stays paused, while deposits, withdrawals and paused closes keep working.

## Upgradeability and admin review

- **Initial state is closed.** v1 `initialize` takes the per-market caps and starts paused, so there is no window where the proxy is open at contract maxima. The manifest validator also refuses caps above the contract bounds (1M per trade, 5M gross).
- **Cap changes.** Governance changes take 72 hours in production. From v1.2 the [risk operator](risk-operator.md) changes caps, risk parameters and spreads at once within governance's envelope, and `setExposurePolicy` no longer requires a paused clearing. The emergency council can only lower caps.
- **Governance can move.** `transferGovernance` then `acceptGovernance` lets the dev owner (or a timelock) hand over without redeploying; the emergency council can never become governance.
- **Upgrades go through the timelock only.** The `ProxyAdmin` is owned by the timelock and there is no emergency upgrade bypass, by design. During an incident the emergency Safe can pause, lower caps and rotate the leader epoch; a code fix takes 72 hours. Users can always withdraw free collateral and close through the paused-close path.
- **Linked libraries are implementation authority.** The six libraries run in the proxy's context through delegatecall. Storage validation runs with `--unsafeAllowLinkedLibraries`, so library changes need the same review as implementation changes.
- **Bytecode headroom.** `RFQClearing` is 18,687 bytes, 5,889 under the EIP-170 limit, which the compile script enforces.
- **`RFQTimelock`** (`contracts/governance/`) is an OpenZeppelin `TimelockController` taking `(minDelay, governanceSafe)`; the tooling requires at least 72 hours.
- **Compiler target** is pinned to `cancun`.
- **Deployer is powerless after deploy.** Preflight and verify both check that it holds no Safe ownership, timelock role or clearing role.

## Blockers before real capital

The deploy itself is cheap and can be undone by redeploying. Accepting customer funds or unpausing is a different decision. From the [implementation plan](../release/implementation-plan.md) and [release checklist](../release/release-checklist.md):

- R16 (qualification, independent audit, capped release) is pending, and R10 (deposit/direct exit app), R11 (persistent hosts, backup/restore) and R15 (calibration and 72-hour soak) are still implementing.
- Every box in the release checklist is open except keeping cross-chain deposits disabled. That includes independent Solidity and economic reviews, an upgrade/rollback rehearsal with open positions, independently custodied approver keys, and the 72-hour soak on the frozen candidate.
- The mainnet runtime (approvers, keeper, hedger with a mainnet Hyperliquid account, indexer, monitoring) has not been provisioned.

`--dormant` exists for this situation: the contracts go live and verified on Base, paused with markets disabled, and `go-live` stays unexecuted until those gates close. The deployment record carries `launchProfile: "dormant"` so nobody mistakes it for a released system.

## Rehearsal

`npm run rehearse:base-mainnet` runs both profiles. For production, it runs the whole sequence on a local OP-stack chain that reports chain ID 8453, with the real USDC address planted with a mock token and stand-in Safes. It checks preflight refusals, an interrupted deploy and resume, all 35 verification checks, that the proxy starts paused with the manifest caps, timelock enforcement (early go-live reverts), unpause, a USDC deposit, and the Basescan payloads. For dev, it covers the ceiling refusal, an owner-key requirement, deploy and unpause, a deposit, an upgrade that preserves custody and collateral, and the handover: refusal while the Safe still administers the timelock, the timelocked `acceptGovernance`, and that the old owner can neither pause nor upgrade afterwards. It also runs as part of `npm run test:contracts`.
