# Base mainnet deployment

Status 2026-10-06: tooling ready and rehearsed locally. **No mainnet transaction has been sent.** Any deploy waits for an explicit go-ahead from the project owner.

There are two profiles:

- **Dev** (next): a development deployment on Base mainnet that replaces Base Sepolia for day-to-day testing, so real USDC and ETH can be used instead of faucet assets. One owner wallet controls everything directly: caps change immediately and upgrades land in a single transaction, with no Safe and no timelock. Caps are hard-limited by the tooling. It is planned for after the contract rewrite and bug fixes.
- **Production** (later): a fresh deployment with Safes, a 72-hour timelock and canary caps. It does not reuse the dev proxy, because the clearing contract has no way to hand governance from the owner wallet to a timelock.

## Dev profile

### What the owner must supply

1. **About 0.02 ETH on Base** sent to the owner address that `dev-identities` prints. That covers the deploy (~0.0001 ETH at normal fees) and many upgrades (~0.00008 ETH each).
2. **Some USDC on Base** for testing: the maker capital floor (100 USDC in the generated manifest) plus whatever test trades need.
3. **The Pyth Core address on Base mainnet**, confirmed on deploy day (see item 6 of the production list). The existing Hermes API key works for mainnet too.
4. **A Base RPC URL.** A paid one (Alchemy, QuickNode) is better, but public `https://mainnet.base.org` works for a low-volume dev deployment.

`dev-identities` generates the owner, emergency and three approver keys into `.local-state/base-mainnet-dev/identities.json` (mode 0600, never committed) and writes a ready `dev-manifest.json` that uses their addresses. To use a wallet you already hold as owner instead, set `owner` in the manifest and pass its key as `RFQ_MAINNET_DEPLOYER_KEY`.

### Dev caps

`validateDevManifest` refuses anything above 1,000 USDC per trade, 5,000 USDC net or 10,000 USDC gross per market, and a 50,000 USDC maker capital floor. The generated manifest uses 25 USDC per trade, 100 net, 200 gross and 150 per side, plus a 100 USDC maker floor. These caps bound trading exposure, not deposits: the contract is public, so anyone who finds it can deposit their own USDC and withdraw it again. Don't publicize the address.

### Commands

```bash
npm run dev-identities:base-mainnet -- PYTH_CORE_ADDRESS   # once; prints the owner address to fund
npm run dev-preflight:base-mainnet -- .local-state/base-mainnet-dev/dev-manifest.json
npm run dev-deploy:base-mainnet -- .local-state/base-mainnet-dev/dev-manifest.json --unpause
npm run dev-verify:base-mainnet -- .local-state/base-mainnet-dev/dev-manifest.json
npm run dev-configure:base-mainnet -- MANIFEST [--unpause]  # after editing caps
npm run dev-upgrade:base-mainnet -- MANIFEST                # after contract changes
npm run dev-basescan:base-mainnet -- MANIFEST
```

`dev-deploy` deploys the same five contracts as production, then pauses, sets exposure and market caps, and (with `--unpause`) reopens trading, all from the owner key. `dev-upgrade` runs the storage-layout check, deploys fresh libraries and a fresh implementation from the current build, and points the proxy at them with one `upgradeAndCall` transaction. Balances and positions stay in place, which the rehearsal checks. Each broadcasting command still requires the `RFQ_MAINNET_DEPLOY_CONFIRM` string it prints, so a stray shell can't send mainnet transactions by accident.

The storage check compares against the frozen `RFQClearingBaseline`, not the deployed implementation, and the layout has fixed `Market[2]` arrays and no storage gap. Rewrites that change storage layout need a fresh dev proxy (move `deployment.json` aside and run `dev-deploy` again) rather than an upgrade.

# Production profile

## What gets deployed

| Order | Contract | Who deploys | Notes |
| --- | --- | --- | --- |
| 0a | Governance Safe | Owner, in the Safe app | 2-of-3 or stronger, hardware-wallet owners |
| 0b | Emergency Safe | Owner, in the Safe app | Different owners from the governance Safe |
| 0c | `RFQTimelock` | `deploy:base-mainnet-timelock` | OpenZeppelin `TimelockController`, 72 h delay. Governance Safe is proposer/executor and must renounce the bootstrap admin role |
| 1 | `RFQRiskMath` | `deploy:base-mainnet` | Linked library, part of implementation authority |
| 2 | `RFQSignatureVerifier` | same | Linked library |
| 3 | `RFQClearing` implementation | same | Constructor disables initializers |
| 4 | `PythCoreAdapter` | same | Bound to the proxy address predicted from the deployer nonce |
| 5 | `TransparentUpgradeableProxy` | same | Calls `initialize`; creates a `ProxyAdmin` owned by the timelock |

Already on Base and only referenced: native USDC `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` (pinned in `mainnet-manifest.ts`) and Pyth Core. `RFQAuthorization` and the Chainlink adapter are not part of this deployment.

## What the owner must supply

1. **Governance Safe** on Base mainnet, at least 2-of-3, hardware-wallet owners. None of the testnet identities qualify.
2. **Emergency Safe** on Base mainnet, at least 2-of-3, with owners that cannot reach the emergency threshold through governance-Safe overlap. Preflight refuses overlapping control.
3. **Three approver signing addresses**, each generated independently (ideally one per host/provider). Only the addresses go in the manifest; keys never touch this repository.
4. **A fresh deployer EOA** funded with about **0.01 ETH** on Base. It ends with no role anywhere (verified), so it can be a single-use hot key. Supplied only through `RFQ_MAINNET_DEPLOYER_KEY` in an ignored env file.
5. **Two independent Base mainnet RPC URLs** (for example Alchemy and QuickNode). The second is used to cross-verify the deployment.
6. **Pyth Core address on Base mainnet**, confirmed against Pyth's docs on deploy day. Pyth upgraded Core and now requires a Hermes API key for price updates. The Base Sepolia deployment uses `0x5f52e4DBEA21f5b23523B6e20d50c29ae0a4EB83`; the historically documented Base mainnet address is `0x8250f4aF4B972684F7b336503E2D6dFeDeB1487a`, but confirm it rather than copying it from here. Preflight checks that the address answers `getUpdateFee`.
7. **Canary policy numbers**: maker capital floor, insurance, daily loss limit and per-market caps (see `deploy/base-mainnet/MANIFEST.example.json`). The maker capital floor is written into `initialize`, and trades fail until that much maker USDC is deposited.
8. **A Basescan API key** (Etherscan v2 key) to publish verified source.

## Cost

Measured in the rehearsal (`npm run rehearse:base-mainnet`):

| Transaction | Gas |
| --- | --- |
| RFQRiskMath | 2,384,469 |
| RFQSignatureVerifier | 594,505 |
| RFQClearing implementation | 4,620,390 |
| PythCoreAdapter | 686,284 |
| Proxy + initialize + ProxyAdmin | 1,055,243 |
| RFQTimelock | 1,381,091 |
| **Total** | **10,721,982** |

L2 execution at 0.01 gwei is about 0.0001 ETH; at a 0.5 gwei spike it is about 0.0054 ETH. Base also charges an L1 data fee for roughly 45 KB of init code, normally cents. Preflight prints the live estimate (including the L1 fee upper bound from the `GasPriceOracle` predeploy) and refuses to proceed unless the deployer holds twice the estimate. Two Safe creations and the four launch batches are paid by the Safe owners and cost a few cents each.

## Procedure

Load an ignored env file first (`set -a; source ./base-mainnet.env; set +a`) holding `RFQ_BASE_MAINNET_RPC_URL`, `RFQ_BASE_MAINNET_SECONDARY_RPC_URL`, `RFQ_MAINNET_DEPLOYER_KEY` and later `RFQ_BASESCAN_API_KEY`. Outputs go to `.local-state/base-mainnet/` with mode 0600.

Every broadcasting command refuses to run until `RFQ_MAINNET_DEPLOY_CONFIRM` equals a string it prints, which binds the action to chain 8453, the deployer address and the candidate (or governance Safe for the timelock).

1. Create both Safes in the Safe app.
2. `npm run deploy:base-mainnet-timelock -- GOVERNANCE_SAFE`, then execute `safe-batches/0-renounce-timelock-admin.json` from the governance Safe (Transaction Builder, "Load batch").
3. Freeze the commit. Write the manifest outside the repository or under `.local-state/`, with `candidateHash` from `npm run candidate:base-mainnet`. Any change to tracked source changes the hash and invalidates the manifest.
4. `npm run preflight:base-mainnet -- MANIFEST.json`. It is read-only: it checks the chain ID, USDC decimals, Pyth, both Safe thresholds and owner overlap, timelock delay and self-administration, that the deployer holds no role, and gas/balance.
5. `npm run deploy:base-mainnet -- MANIFEST.json --dormant` (or `--release-evidence EVIDENCE.json` once `release:check` passes). It deploys steps 1–5, waits two confirmations per transaction, and writes `deployment.json` plus four Safe batches. An interrupted run resumes from `deployment.partial.json`; the adapter is re-checked against the next proxy address.
6. **Immediately** execute `safe-batches/1-emergencyPause.json` from the emergency Safe: pause, and disable both markets at canary caps. See "Initial state" below for why.
7. `npm run verify:base-mainnet -- MANIFEST.json` runs 32 checks against both RPCs: implementation and library runtime bytecode equal the local build, proxy slots, ProxyAdmin owned by the timelock, every role, approvers, capital floor, adapter feeds and binding, timelock self-administration, and no deployer authority.
8. `npm run basescan:base-mainnet -- MANIFEST.json` publishes standard-JSON source for all five contracts.
9. Execute `safe-batches/2-governanceSchedule.json` from the governance Safe. It schedules two timelock operations: `configure` (gross/side exposure caps, enable markets at canary caps) and `go-live` (unpause), which depends on `configure`.
10. After 72 hours, execute `3-governanceConfigure.json`. Run verify again.
11. Execute `4-governanceGoLive.json` only once the approvers, keeper, hedger, indexer and monitoring are running against mainnet and the release checklist allows it. Until then the deployment stays paused, while deposits, withdrawals and paused closes keep working.

## Upgradeability and admin review

- **Initial state is open.** `initialize` enables both markets at the contract maxima (1M USDC per trade, 5M per market) and leaves the clearing unpaused. Nothing can trade without two approver signatures and the maker capital floor deposited, so the practical exposure between steps 5 and 6 is nil while approver keys stay offline. Step 6 still closes it right away, because the emergency Safe can only reduce risk.
- **Caps take at least 72 hours.** `setExposurePolicy` is governance-only and requires the clearing to be paused, so per-market gross/side caps arrive through the timelock. Scheduling them right after deploy overlaps the delay with runtime setup.
- **Upgrades go through the timelock only.** The `ProxyAdmin` is owned by the timelock and there is no emergency upgrade bypass, by design. During an incident the emergency Safe can pause, lower caps and rotate the leader epoch; a code fix takes 72 hours. Users can always withdraw free collateral and close through the paused-close path.
- **Linked libraries are implementation authority.** `RFQRiskMath` writes proxy storage through delegatecall. Storage validation runs with `--unsafeAllowLinkedLibraries`, so library changes need the same review as implementation changes.
- **Bytecode headroom is 5 bytes.** `RFQClearing` is 20,995 bytes against the project's 21,000-byte gate (EVM limit 24,576). Any post-deploy fix to the clearing will need logic moved into a library or a deliberate decision to raise the gate.
- **`RFQTimelock` lives in `contracts/testnet/`** but is an unmodified OpenZeppelin `TimelockController` with a fixed 3-day delay. It is reused for mainnet as is; moving the file is left to the refactor track.
- **Compiler target.** `evmVersion` is unpinned, so solc 0.8.34 defaults to `osaka`. A `prague` build of all four deployed contracts is byte-identical apart from metadata, so no Osaka-only opcode is emitted today. Pinning it is still worthwhile in the rewrite.
- **Deployer is powerless after deploy.** Preflight and verify both check that it holds no Safe ownership, timelock role or clearing role.

## Blockers before real capital

The deploy itself is cheap and can be undone by redeploying. Accepting customer funds or unpausing is a different decision. From `PRODUCTION-IMPLEMENTATION-PLAN.md` and `PRODUCTION-RELEASE-CHECKLIST.md`:

- R16 (qualification, independent audit, capped release) is pending, and R10 (deposit/direct exit app), R11 (persistent hosts, backup/restore) and R15 (calibration and 72-hour soak) are still implementing.
- Every box in the release checklist is open except keeping cross-chain deposits disabled. That includes independent Solidity and economic reviews, an upgrade/rollback rehearsal with open positions, independently custodied approver keys, and the 72-hour soak on the frozen candidate.
- The mainnet runtime (approvers, keeper, hedger with a mainnet Hyperliquid account, indexer, monitoring) has not been provisioned.

`--dormant` exists for this situation: the contracts go live and verified on Base, paused with markets disabled, and `go-live` stays unexecuted until those gates close. The deployment record carries `launchProfile: "dormant"` so nobody mistakes it for a released system.

## Rehearsal

`npm run rehearse:base-mainnet` runs both profiles. For production, it runs the whole sequence on a local OP-stack chain that reports chain ID 8453, with the real USDC address planted with a mock token and stand-in Safes. It checks preflight refusals, an interrupted deploy and resume, all 32 verification checks, the emergency batch, timelock enforcement (early configure and out-of-order go-live both revert), the configured caps, unpause, a USDC deposit, and the Basescan payloads. For dev, it covers the ceiling refusal, an owner-key requirement, deploy plus immediate caps and unpause, a deposit, an upgrade that preserves custody and collateral, and verification after the upgrade. It also runs as part of `npm run test:contracts`.
