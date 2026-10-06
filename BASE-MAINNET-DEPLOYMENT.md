# Base mainnet deployment

Status 2026-10-06: tooling ready and rehearsed locally. **No mainnet transaction has been sent.** The deploy waits for an explicit go-ahead from the project owner.

This guide covers deploying the core settlement contracts to Base mainnet (chain 8453) and taking them to a capped canary. It does not cover the off-chain runtime (API, approvers, keeper, hedger, indexer), which stays on Base Sepolia until its own gates pass.

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
- **Deployer is powerless after deploy.** Preflight and verify both check that it holds no Safe ownership, timelock role or clearing role.

## Blockers before real capital

The deploy itself is cheap and can be undone by redeploying. Accepting customer funds or unpausing is a different decision. From `PRODUCTION-IMPLEMENTATION-PLAN.md` and `PRODUCTION-RELEASE-CHECKLIST.md`:

- R16 (qualification, independent audit, capped release) is pending, and R10 (deposit/direct exit app), R11 (persistent hosts, backup/restore) and R15 (calibration and 72-hour soak) are still implementing.
- Every box in the release checklist is open except keeping cross-chain deposits disabled. That includes independent Solidity and economic reviews, an upgrade/rollback rehearsal with open positions, independently custodied approver keys, and the 72-hour soak on the frozen candidate.
- The mainnet runtime (approvers, keeper, hedger with a mainnet Hyperliquid account, indexer, monitoring) has not been provisioned.

`--dormant` exists for this situation: the contracts go live and verified on Base, paused with markets disabled, and `go-live` stays unexecuted until those gates close. The deployment record carries `launchProfile: "dormant"` so nobody mistakes it for a released system.

## Rehearsal

`npm run rehearse:base-mainnet` runs the whole sequence on a local OP-stack chain that reports chain ID 8453, with the real USDC address planted with a mock token and stand-in Safes. It checks preflight refusals, an interrupted deploy and resume, all 32 verification checks, the emergency batch, timelock enforcement (early configure and out-of-order go-live both revert), the configured caps, unpause, a USDC deposit, and the Basescan payloads. It also runs as part of `npm run test:contracts`.
