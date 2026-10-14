# RFQ Markets: smart contract audit notes

Scope: `contracts/**`, `hardhat.config.js`, `scripts/compile-contracts.mjs`, `scripts/link-artifact.mjs`, the contract e2e scripts, the deploy, upgrade and verify scripts, and `CONTRACT-IMPLEMENTATION.md`, `AUTHORIZATION-AND-UPGRADES.md` and `BASE-SEPOLIA-DEPLOYMENT.md`. I modified no repo files. `artifacts/` is gitignored and `git status` is clean.

Where a statement is inferred rather than read directly from code, it is marked "(inferred)".

---

## 0. Build and test results (run 2026-10-06, Node v22.22.0, `npm ci` OK)

| Command | Result |
|---|---|
| `npm ci` | OK. 344 packages. npm reports 13 dev vulnerabilities (6 low, 4 moderate, 3 high); none were triaged. |
| `npm run compile:contracts` | OK in about 58s with solc-js 0.8.34 (emscripten). Output: `RFQClearing deployed bytecode: 20995 bytes (project gate: 21,000; EVM limit: 24,576)` |
| `npm run validate:upgrades` | `✔ contracts/RFQClearing.sol:RFQClearing (upgrades from contracts/test/RFQClearingBaseline.sol:RFQClearingBaseline)`, `SUCCESS` |
| `npm run test:contracts` | All pass (exit 0). Runs contract-e2e, clearing-e2e, bankruptcy-e2e (4 sub-scenarios), exposure-e2e, risk-differential (1500 vectors, 13,500 comparisons), stateful-clearing-e2e (600 steps plus a resolution regression), api-settlement-e2e, gross-reservation-e2e, keeper-e2e and account-response-e2e. |

### Deployed bytecode sizes (from `artifacts/*.json`)

| Contract | Bytes | Linked libraries |
|---|---|---|
| RFQClearingV2 (test) | 21,033 (over the 21k gate, but the gate only checks RFQClearing) | RFQRiskMath, RFQSignatureVerifier |
| **RFQClearing** | **20,995** | RFQRiskMath, RFQSignatureVerifier |
| RFQClearingBaseline (test) | 20,887 | RFQRiskMathBaseline |
| RFQRiskMath | 10,785 | none |
| RFQAuthorization (reference, not deployed) | 5,891 | none |
| RFQTimelock / TimelockController | 5,375 | none |
| RFQRiskMathBaseline | 3,195 | none |
| PythCoreAdapter | 2,694 | none |
| RFQSignatureVerifier | 2,504 | none |
| ChainlinkDataStreamsV3Adapter | 1,709 | none |
| ProxyAdmin / TransparentUpgradeableProxy | 872 / 752 | none |

**Headroom.** RFQClearing has **5 bytes** left under the project gate in `scripts/compile-contracts.mjs:94-97` and 3,581 bytes under the EIP-170 limit of 24,576.

`CONTRACT-IMPLEMENTATION.md:63` still says "Runtime bytecode is 20,850 bytes". That figure is out of date.

The gate only checks `RFQClearing`. It does not check the libraries or any other contract.

### Compiler sensitivity

I ran a scratch experiment that compiled only the clearing and library sources with solc 0.8.34 from `node_modules`:

| Settings | RFQClearing size | Effect |
|---|---|---|
| `evmVersion: cancun` (pinned) | 20,995 | Unchanged, so no Osaka-only opcodes are needed. |
| `optimizer.runs: 200` | 21,080 | **Fails the gate.** |
| `viaIR: false` | n/a | **Stack too deep** at `RFQRiskMath.sol:55`. The code depends on via-IR. |

**What a solc bump might do.** The repo has no other solc version installed and I installed nothing extra, so I could not test this directly. Small codegen changes between versions commonly move size by tens to hundreds of bytes, and there are only 5 bytes of headroom. Any solc bump (or any one-line feature) has a high chance of tripping the 21,000 gate (inferred). It would not come near the 24,576 EVM limit.

The gate is a self-imposed feature-creep brake, not a safety limit. The realistic options are:
- move it to roughly 22,500 or 23,000 explicitly, or
- move more logic (for example liquidation or resolution) into `RFQRiskMath`, which is only 10.8k.

**`evmVersion` is not pinned** in `compile-contracts.mjs:44-51`. solc 0.8.34 defaults to **osaka**. I scanned the bytecode: the CLZ (0x1e) and TLOAD (0x5c) bytes in RFQClearing sit in the data area just before the metadata, not in code (inferred from position). PythCoreAdapter does use MCOPY, which needs Cancun; Base has supported Cancun since Ecotone. Pin `evmVersion` (for example `cancun` or `prague`) so a future compile cannot silently emit opcodes Base does not support.

---

## 1. Contracts and libraries

### 1.1 `contracts/RFQClearing.sol` (605 lines). Core clearing house; implementation behind a proxy.

**Purpose.** On-chain custody and clearing for two USDC-margined perpetual-style markets, BTC (`market=0`) and ETH (`market=1`), filled by RFQ.
- The protocol's own maker is the sole counterparty, represented by the `makerBacking` bucket.
- Each trade needs three signatures: the user's (or their session key's) and 2 of 3 approvers'.
- Contract notice: "First executable clearing prototype. It is deliberately capped at BTC/ETH." (`:18`)

**Upgradeability.**
- Inherits only `Initializable`. It is not UUPS, so the implementation has no upgrade function.
- The constructor calls `_disableInitializers()` (`:143`).
- It is deployed behind an OZ 5 `TransparentUpgradeableProxy` whose auto-created `ProxyAdmin` is owned by `governance` (`scripts/deploy-base-sepolia.ts:23`).
- `@custom:oz-upgrades-from RFQClearingBaseline` (`:20`) points the OZ validator at a frozen copy, `contracts/test/RFQClearingBaseline.sol`, described as "frozen ... from commit 6c04310".
- Storage is append-only. `marketLimitWord` (`:119`) was the first extension and `RFQRiskMath.ExposureControls _exposure` (`:120`) was the second.
- There is no `__gap`.

**Units.**
- USDC: 6 decimals.
- Base size: 1e18.
- Prices: USDC micro-units per 1 whole token, so notional = `base * price / 1e18`.
- Funding `RATE` is 1e12 = 100% APR (`RFQRiskMath.sol:167`).

**Constants (`:24-53`).**
- `MAX_ORACLE_AGE = 15` seconds.
- `MAX_WIDTH_BPS = 100`, so bid/ask may be at most 1% apart.
- `ABSOLUTE_MAX_TRADE_NOTIONAL = 1,000,000 USDC` and `ABSOLUTE_MAX_MARKET_NOTIONAL = 5,000,000 USDC`.
- EIP-712 typehashes: `TradeIntent`, `MakerApproval`, `WithdrawalIntent`, `CancelIntent`, `CloseIntent`, `SessionGrant`.
- Several constants are now unused in this file because the logic moved into libraries: `LIQUIDATION_PENALTY_BPS`, `KEEPER_REWARD_BPS`, `MAX_SESSION_DURATION`, `DOMAIN_TYPEHASH`, `NAME_HASH`, `VERSION_HASH`, `INTENT_TYPEHASH`, `APPROVAL_TYPEHASH`. Each appears exactly once (its declaration). They are `internal constant`, so they cost no bytecode, but they duplicate the library constants.

**State (`:83-120`).**
- `usdc`, `oracle` (IPriceOracle), `governance`, `emergencyCouncil`.
- `approvers[3]` and `isApprover`.
- `_accounts`: per account, an `int256 collateral` plus `positions[market]` as `{size, entryPrice, lastFundingIndex}`.
- `accountRegistered` and `_accountList` (append-only registry, used for resolution and migration).
- `nonceUsed[account][nonce]`.
- `markets[2]`: `{aggregateBase, fundingIndex, fundingTime, lastPriceTime, lastBid, lastAsk, enabled}`.
- Capital buckets: `makerBacking`, `insuranceBalance`, `totalCustomerCollateral`, and `baseRiskCapitalTarget` (the opening floor).
- Versions: `leaderEpoch`, `signerSetVersion`, `policyVersion`.
- `paused`, `resolutionRequired`, and a storage-based reentrancy flag `_entered`.
- Resolution state: trigger time, three samples per market, `resolutionPrice[2]`, cursor, claims, assets, paid.
- `sessions[sessionKey]`: `{account, validUntil, marketMask, maxTradeNotional, maxCumulativeNotional, usedNotional, maxFee}`.
- `marketLimitWord[market]`: two packed uint128 values, per-trade limit and net-market limit.
- `_exposure`: gross long and short base books, packed gross and side limits, migration cursor, `ready` and `scanned`.

**External and public functions.**

| Function | Line | Auth | Notes |
|---|---|---|---|
| `initialize(usdc, oracle, gov, emergency, approvers[3], baseRiskCapitalTarget)` | 145 | initializer | Starts **unpaused**, both markets enabled, limits at the absolute maximums (1M/5M) and exposure limits at 5M/5M. |
| `deposit(amount)` | 177 | anyone | Exact-balance pull. The first deposit must be at least 10 USDC (`:592`). |
| `depositWithAuthorization(...)` | 185 | anyone (EIP-3009 `receiveWithAuthorization`) | Credits `from`. |
| `fundMaker`, `fundInsurance` | 199, 205 | anyone | Permissionless top-ups. |
| `refreshOracle(report)` | 211 | anyone, payable | Records the observation and accrues funding. **No monotonicity check** (see §5). |
| `withdraw`, `withdrawWithSignature` | 218, 223 | owner, or sponsored with the owner's EIP-712 signature | Requires fresh prices for open legs (`_requireFreshPositions`) and initial margin after the withdrawal. Allowed while paused. |
| `cancelNonce`, `cancelNonceWithSignature` | 232, 237 | owner, or sponsored | |
| `closePosition`, `closePositionWithSignature` | 244, 249 | owner, or sponsored | **Only while paused.** Closes the whole leg at oracle bid or ask with no approvers. |
| `executeTrade(intent, approval, report, userSig, sigA, sigB)` | 257 | anyone (relayer) | The RFQ settlement path (see §2). |
| `liquidate(account, market, report)` | 290 | anyone (keeper), payable | Partial or full liquidation, portfolio bankruptcy, then the waterfall. |
| `maintenanceEquity`, `openingEquity`, `initialMargin`, `maintenanceMargin` | 342-345 | view | |
| `setExposurePolicy(market, gross, side)` | 347 | governance, only while paused | Bumps `policyVersion`. |
| `migrateExposure(maxAccounts)` | 351 | anyone, only while paused | 1 to 200 accounts per call. |
| `exposureState(market)` | 355 | view | |
| `pause()` | 359 | emergency or governance | Also increments `leaderEpoch`. |
| `unpause()` | 360 | **governance only** | Requires `!resolutionRequired && _exposure.ready`. |
| `advanceLeaderEpoch(expected)` | 361 | emergency or governance | Compare-and-swap on the epoch. |
| `rotateApprovers(next[3])` | 364 | governance | Bumps `signerSetVersion` and `leaderEpoch`. |
| `setOracle(next)` | 365 | governance | Bumps `policyVersion`. Blocked during resolution. |
| `setMarketPolicy(market, enabled, maxTrade, maxMarket)` | 366 | governance (any change), or emergency (disable or tighten only) | Bumps `policyVersion`. |
| `withdrawMakerExcess(recipient, amount)` | 375 | governance | Remaining backing must be at least the floor, and stress loss at most 25% of the remainder. |
| `grantSessionWithSignature(grant, sig)` | 386 | owner signature only | Overwrites `sessions[session]` unconditionally (`:548`). |
| `revokeSession(session)` | 395 | the session's account | |
| `declareResolution()` | 403 | governance (if paused), or **anyone** if `makerIncident` holds | |
| `submitResolutionObservation(report)` | 410 | anyone, payable | First three post-trigger samples per market; the first and third must be at least 30s apart; the median is used. |
| `processResolution(maxAccounts)` | 431 | anyone | Bounded crystallization of claims. |
| `claimResolution()` | 449 | the claimant | Pro-rata payout. |
| `addResolutionRecovery(amount)` | 459 | anyone | Capped at total claims. |
| public getters | various | | `usdc`, `oracle`, `governance`, `emergencyCouncil`, `approvers`, `isApprover`, `accountRegistered`, `nonceUsed`, `markets`, buckets, versions, `paused`, `resolution*`, `sessions`, `marketLimitWord`. |

**Events (`:122-137`):** `Deposited`, `Withdrawn`, `NonceCancelled`, `PositionClosed`, `MakerWithdrawn`, `SessionGranted`, `SessionRevoked`, `TradeExecuted`, `FundingSettled`, `Liquidated`, `DeficitAbsorbed`, `EpochAdvanced`, `ResolutionStarted`, `ResolutionPriceReady`, `ResolutionFinalized`, `MarketPolicyUpdated`.
- Library events emitted from proxy context: `PositionClosed` and `FundingSettled` (redeclared in RFQRiskMath), plus `ExposurePolicyUpdated` and `ExposureMigrationProgress`. The last two are only in RFQRiskMath's ABI, so indexers must merge ABIs (inferred).
- There are no events for `fundMaker`, `fundInsurance`, `unpause`, `setOracle`, `rotateApprovers` (only `EpochAdvanced`), `claimResolution` or `addResolutionRecovery`. That is an observability gap.

**Errors:** a deliberately tiny set (`Unauthorized`, `InvalidTrade`, `InvalidSignature`, `Stale`, `Replay`, `Margin`, `OracleInvalid`, `Insolvent`). They are reused across unrelated conditions to save bytecode. For example, `approval.fee > intent.maxFee` reverts with `Replay` (`RFQSignatureVerifier.sol:22`). This makes debugging and testing imprecise.

### 1.2 `contracts/libraries/RFQRiskMath.sol` (289 lines). External linked library, 10,785 bytes.

**Mechanics.**
- It is called by delegatecall because its functions are `public`.
- Despite the name it is not pure: it writes proxy storage through typed storage pointers. Writes include exposure counters, portfolio clearing, funding-index recording, approver rotation and resolution crystallization.
- `ACCOUNTING-AND-RESOLUTION.md` "Library/storage boundary" acknowledges this.
- It imports `../RFQClearing.sol` for struct types, a circular import (`:4`).

**Contents.**
- Exposure book: `ExposureControls` (`:13-16`), `initializeExposure` (`:20`), `setExposurePolicy` (`:24`, hard-coded `5_000_000e6`), `migrateExposure` (`:30`, at most 200 per call), `updateExposure` (`:39`).
- `checkExposureTrade` (`:46-73`). Canonical admission:
  - capital floor and enabled market for non-reductions;
  - gross, side and net bounds per market, valued at `lastAsk`;
  - 6-scenario stress loss at most `backing/4`;
  - the "reduction may improve a breach" rule (`_bound`, `:74`).
- `validateEconomics` (`:77-92`): per-trade limit, session caps, `reduceOnly`, and `impactCharge >= requiredImpact` and `deliveredImpact >= impactCharge`.
- Inventory impact: `potential(btc, eth) = (K_BTC*btc² + 2*K_CROSS*btc*eth + K_ETH*eth²) / (2*RATE*1e6)` with K = 10,000, 12,000 and 6,573 (`:167-174`). `impactCost` is the change in potential.
- `stressLoss` (`:197-206`): six fixed shock scenarios (±20/25%, ±15/∓20%, ±40/50%).
- `marginRate` (`:208-216`): tiered initial and maintenance margin from 20%/12% up to 100%/60%; above 5M notional it reverts with `Margin`.
- `liquidationClose` (`:218-228`): targets 22% equity, closes at most 25% per call, and closes in full if notional is at most $10k or equity is at most 0. `liquidationCharge` (`:230-235`): 50 bps penalty, keeper gets min(10 bps, 20% of penalty).
- `positionTransition` and `positionPnl`.
- `fundingStep` (`:262-276`): APR = skewNotional / maxMarketNotional, clamped to ±100%.
- Bookkeeping: `deficitAssessment`, `closeAssessment`, `clearPortfolio`, `fundingPayments`, `recordFunding`, `processResolutionAccounts`, `pullExact`, `setApprovers`, `makerIncident`, `accountEquity` and `accountMargin`.
- `enforceAggregateRisk` (`:147-150`) is **dead code**: nothing references it.

### 1.3 `contracts/libraries/RFQSignatureVerifier.sol` (34 lines). External linked library, 2,504 bytes.

- Builds the EIP-712 domain dynamically from `address(this)` and `block.chainid` (`:15`).
- `validOwnerSignature` uses OZ `SignatureChecker`, so EOAs and ERC-1271 (and 7702) accounts are supported.
- `validateIntent` (`:17-29`):
  - deadlines;
  - epoch, signer-set and policy versions all match;
  - nonce unused;
  - fee within `maxFee`;
  - limit price respected;
  - the approval's `intentHash` equals the digest;
  - otherwise the signature is ECDSA-recovered as a **session key** and checked against the session's account, expiry, market mask and fee cap.
- `validateApproval` (`:30-33`): 2 distinct recovered approvers (ECDSA only; ERC-1271 approvers are not supported).
- Typehash strings are duplicated from RFQClearing.

### 1.4 `contracts/RFQAuthorization.sol` (286 lines). **Reference only, not deployed.**

- The header says "Reference implementation for review and invariant work; not deployment-ready" (`:38`).
- It uses a **different** `TradeIntent` typehash (`notionalDelta`, no `reduceOnly`) from RFQClearing and has its own signature library (`SignatureValidation`).
- Only `contract-e2e.mjs` and `contracts/test/RFQInvariants.sol` use it. So the first test in `test:contracts`, and the only Solidity "invariant" contract, exercise dead code rather than the deployed clearing logic.

### 1.5 Oracle adapters (`contracts/interfaces/IPriceOracle.sol`, `contracts/oracle/*`)

- **`IPriceOracle.verify(bytes) payable returns Observation{market, bid, ask, observedAt, validUntil}`.**
- **`PythCoreAdapter`** (71 lines, used on testnet):
  - Immutable `pyth`, immutable `clearing`, and `feedIds[2]`. Only `clearing` may call `verify`.
  - The report is `abi.encode(uint8 market, bytes[] updates)`.
  - Requires `msg.value == getUpdateFee` exactly.
  - Calls `parsePriceFeedUpdates` with a window of [now-15, now+5] (`:46-49`).
  - Builds bid and ask as `price ∓ conf`, scaled to 6 decimals with outward rounding (`:56-62`). `validUntil = publishTime + 15`.
  - Rejects `conf >= price` and nonpositive prices.
  - `updateFee(report)` is a view helper.
- **`ChainlinkDataStreamsV3Adapter`** (65 lines, not deployed anywhere in the repo docs):
  - Immutable verifier proxy and clearing, plus `feedIds` and `feedDecimals`.
  - Calls `verifier.verify{value: msg.value}(report, bytes(""))` (`:43`), decodes v3 (`feedId`, timestamps, fees, `price`, `bid`, `ask`) and normalizes decimals.
  - `validFromTimestamp` is ignored.
  - Empty `parameterPayload` and no LINK or native fee approval means it likely reverts on any VerifierProxy that has a FeeManager configured (inferred; the doc at `CONTRACT-IMPLEMENTATION.md:37` assumes subscription billing). It has only been tested against `MockStreamsVerifier`.

### 1.6 `contracts/testnet/RFQTimelock.sol` (16 lines)

- An OZ `TimelockController` with a **hard-coded 3-day delay**. The single governance Safe is proposer, executor and initial admin (`:9`).
- `finalize-testnet-governance.ts` makes the Safe renounce `DEFAULT_ADMIN_ROLE`, leaving the timelock self-administered.
- It lives under `contracts/testnet/`. There is no mainnet governance contract.

### 1.7 Test and mock contracts

| Contract | Role |
|---|---|
| `test/RFQClearingBaseline.sol` (612 lines) and `test/RFQRiskMathBaseline.sol` (126 lines) | Frozen previous version, used for storage-layout validation and an upgrade regression in `bankruptcy-e2e.mjs`. |
| `test/RFQClearingV2.sol` | Trivial V2 that adds `implementationVersion()`. |
| `test/TestProxy.sol` | A `TransparentUpgradeableProxy` subclass so the artifact is emitted. |
| `test/Mock1271Wallet.sol` | Mock ERC-1271 wallet. |
| `test/RFQInvariants.sol` | Two "invariants" on RFQAuthorization's `impactCost` and `potential`. |
| `mocks/MockUSDC.sol` | `receiveWithAuthorization` **ignores the signature**; `mint` and `burn` are open. |
| `mocks/MockPriceOracle.sol` | Decodes any `Observation`: no authentication, and it accepts ETH. |
| `mocks/MockPythCore.sol`, `mocks/MockStreamsVerifier.sol` | Oracle source mocks. |

---

## 2. On-chain flows

### 2.1 RFQ trade (`executeTrade`, `RFQClearing.sol:257-284`)

1. Reject if `paused`, `resolutionRequired`, `market > 1` or `baseDelta == 0`.
2. `_verifyReport` (`:521-527`):
   - forwards `msg.value` to `oracle.verify`;
   - requires the market to match, `bid > 0` and `ask >= bid`;
   - requires `observedAt <= now <= validUntil` and age at most 15s;
   - requires width at most 1% of mid.

   `_recordObservation` then **overwrites** last bid, ask and time.
3. `_updateFunding` for this market at the report mid, then `_settleFunding` for this account and market only. The other market's unsettled funding is ignored in the margin check that follows (inferred minor).
4. If funding settlement triggered resolution (maker cannot pay), return without reverting. No nonce is consumed and no trade happens.
5. `RFQSignatureVerifier.validateIntent`: user (EOA, ERC-1271 or session key) plus versions, deadlines, nonce, fee cap and limit price.
6. `validateApproval`: 2 distinct members of `isApprover` sign `MakerApproval{intentHash, executionPrice, impactCharge, fee, oracleReportHash, deadline, leaderEpoch, signerSetVersion, policyVersion}`.
7. `approval.oracleReportHash == keccak256(report)`. Approvers bind the exact oracle proof.
8. `validateEconomics`:
   - non-reductions must be within the per-trade limit;
   - session per-trade and cumulative caps;
   - the `reduceOnly` flag;
   - `impactCharge >= impactCost(current aggregate inventory)`;
   - `deliveredImpact >= impactCharge`, where delivered impact is execution price minus ask for buys, or bid minus execution price for sells.
9. `checkExposureTrade`: the capital floor (backing at or above `baseRiskCapitalTarget`, after projected realized PnL) and the enabled market for non-reductions; gross, side and net bounds; stress loss at most `backing/4`. All markets with gross positions must have prices at most 15s old (`RFQRiskMath.sol:56`).
10. `_applyPosition`:
    - realized PnL goes through `_transferPnl`. If a customer gain exceeds `makerBacking`, resolution starts and the function returns without applying;
    - update exposure counters, size, entry and `aggregateBase`.
11. Consume the nonce, add session `usedNotional`, charge the fee (20% to insurance while insurance is under 25% of the floor, else 10%; the rest to maker), then require `collateral >= 0` and `openingEquity >= initialMargin`. Opening equity excludes positive unrealized PnL. Emit `TradeExecuted`.

### 2.2 2-of-3 approver quorum

- `approvers[3]` plus `isApprover`, set by `RFQRiskMath.setApprovers`, which rejects zero and duplicate addresses.
- Any 2 distinct of the 3 must sign the same approval digest.
- Fencing works through versions bound into the approval:
  - `pause` and `advanceLeaderEpoch` bump `leaderEpoch`;
  - `rotateApprovers` bumps `signerSetVersion` and the epoch;
  - every policy change bumps `policyVersion`.

  The user intent does not include these versions, so an unexpired user intent can be re-approved after a failover.
- Only governance, behind the timelock, can rotate approvers. The emergency council can only pause or fence. If an approver key is compromised, the response is: pause and fence immediately, then replace through the timelock (at least 72h of trading downtime).

### 2.3 Margin

- Cross-margin across the 2 markets. `accountMargin` values each leg at `lastAsk`, longs and shorts alike, conservatively.
- Initial-margin checks use `openingEquity`: collateral plus only negative unrealized PnL, with longs marked at bid and shorts at ask.
- Liquidation uses `maintenanceEquity`, which includes positive unrealized PnL.
- Withdrawals and trades require `collateral >= 0` and `openingEquity >= initialMargin` (`:282`, `:488`).
- Leverage is tiered by per-market notional (`marginRate`, `RFQRiskMath.sol:208`). A notional above 5M reverts.

### 2.4 Liquidation and bankruptcy (`:290-325`)

- Anyone can liquidate with a fresh report for `market`. All other legs must already be fresh (refreshed separately).
- Funding is accrued and settled for both markets.
- The account must have equity below maintenance margin.
- If `equity <= 0`, **portfolio bankruptcy**: `_closePortfolio` nets all legs at stored bid or ask, transfers net PnL against the maker once, and clears positions.
- Otherwise a partial close of the chosen market, sized by `liquidationClose`. If collateral goes negative, the rest of the portfolio is also closed.
- The penalty (50 bps of closed notional, capped by positive collateral) goes to insurance minus the keeper reward. The reward is transferred to `msg.sender`.
- `_absorbDeficit`: negative collateral after flattening is covered by insurance first, then maker backing. Any unresolved remainder starts global resolution.
- `bankruptcy-e2e.mjs` checks that the choice of market does not change the waterfall.

### 2.5 Global resolution (ADL substitute)

There is **no ADL**. Instead the whole venue moves to a **one-way terminal "resolution" state**.

**Triggers:**
- maker cannot pay a realized gain or funding credit (`_transferPnl`, `:571`);
- an unresolved deficit after a liquidation or owner close;
- governance while paused;
- anyone, if `makerIncident` holds: open gross exposure exists AND (backing below the floor OR stress loss above backing/4) (`RFQRiskMath.sol:151`).

**Steps:**
1. `_startResolution` freezes funding at the trigger, pauses the venue and bumps the epoch.
2. Anyone submits the first 3 post-trigger observations per market. They must be monotonic, and the first and third must be at least 30s apart. Each market's price is the median.
3. `processResolution` crystallizes each registered account's claim, `max(0, collateral + PnL at the resolution price − unsettled funding)`, in batches.
4. At the end, `resolutionAssets = usdc.balanceOf(this)`, which includes the maker and insurance buckets, and claims are paid pro-rata (`claimResolution`) up to 100%.
5. `addResolutionRecovery` lets anyone top up assets, capped at total claims.

There is no way back to normal operation except an upgrade.

### 2.6 Funding

- Funding is per market, continuous, and accrued on each oracle touch (`fundingStep`, `RFQRiskMath.sol:262`): `APR = clamp(aggregateBase*mark / maxMarketNotional, ±100%)`, so `index += mark*|APR|*elapsed/(1e12*365d)`.
- Longs pay when customers are net long. The maker receives the net.
- The rate's denominator is the governance or emergency-set **net market limit** (`marketLimitWord >> 128`). `setMarketPolicy` does **not** accrue funding before changing that limit (`:366-372`). The new rate therefore applies retroactively to the whole interval since the last accrual (inferred bug; the interval is usually seconds because of frequent refreshes).

### 2.7 Oracle adapters

- Pyth is the live path; Chainlink Data Streams v3 is untested live (see §1.5).
- The clearing contract enforces age (15s), expiry, width (1%) and market.
- Approvers sign the exact report hash, and the API requires the observation to be at most 8s old (docs).
- `refreshOracle` is permissionless and **not monotonic**: an older but still valid report can overwrite a newer one (`_recordObservation`, `:528-530`).

### 2.8 Exposure caps and gross reservations

**On chain:**
- per-trade limit and net-market limit (`marketLimitWord`);
- gross and per-side caps (`_exposure.limits`, valued at ask);
- stress loss at most backing/4;
- capital floor.

Reductions may proceed above caps as long as they do not worsen any metric (`_bound`).

**Off chain** (`contracts/GROSS-APPROVAL-RESERVATIONS.md`):
- API and approver SQLite journals reserve the full directional delta per outstanding approval and release it only after finalized chain time passes the approval deadline.
- With 2-of-3, any two quorums intersect at one honest signer. A compromised signer could create conflicting certificates, but on-chain caps reject the excess.
- This is a liveness and availability control. The canonical safety check is on chain.

### 2.9 Timelock and governance

- `governance` is meant to be a `TimelockController`; on testnet that is `RFQTimelock`, 72h, owned by a 2-of-3 Safe.
- `emergencyCouncil` is a separate 2-of-3 Safe.
- The ProxyAdmin is owned by the timelock.

**Governance can:** unpause; rotate approvers; set the oracle; loosen market policy; set exposure policy (only while paused); withdraw maker excess (floor and stress-bounded); declare resolution while paused; upgrade (through the ProxyAdmin).

**The emergency council can:** pause; advance the epoch; disable or tighten markets. It cannot unpause, upgrade or move funds.

---

## 3. Addresses in the repo

### 3.1 Base Sepolia (84532). "Main"/governed rehearsal stack (`BASE-SEPOLIA-DEPLOYMENT.md:7-17`)

| Component | Address | Notes |
|---|---|---|
| Clearing proxy | `0x1114cA912b2c3440C7D6B5dcdaB499f897C86782` | Also in `VALIDATION-REPORT.md:77`. |
| Clearing implementation | `0xB7Df1f1718e8E487D6673B912b99248C5f731B9F` | An **older** implementation. The doc lists only a RiskMath library, with no RFQSignatureVerifier and no exposure controls (inferred from the table). |
| RFQRiskMath library | `0x0967d24F4c8BF63064Fd39EBf413b1073a5B8eB2` | |
| Pyth adapter (active per doc) | `0x8Ba3F42B417824b9550253573D75Dc4fe22dC5ec` | |
| Scheduled replacement Pyth adapter | `0x414a98e864984697e3e81b8844e5810c6D5DB9b2` | Timelock op `0xd0303c4c6d05c05d09c5e934b74ac5fca2f61b98d5dc6b0cf8ce8635b5d09b7f`, executable after Unix `1789318714` (2026-09-13 16:58 UTC). The repo does not record whether it was executed; `npm run upgrade:base-sepolia-pyth` executes it. |
| ProxyAdmin | `0x28fda3da2507189e8c0d0b62d2bd2d2a339926ba` | Owned by the timelock. |
| Governance timelock (RFQTimelock, 72h) | `0x53324175fEC3F1C6d3eF48C946ce3a7A94FAC765` | Self-administered after renounce tx `0x9efed062ac7e3ad8d440d9db860c46eb0ae2398bf59d7b119df991f15cf859d0`. |
| Governance Safe (2-of-3) | `0xA2C1b91a86FE748c75B17D4Df9C445c2eE315494` | Sole proposer and executor. |
| Emergency Safe (2-of-3) | `0x09382dBc66dAd74232f72ba1E2894b442bEF9Ef7` | `emergencyCouncil`. |
| Native USDC (Circle, Base Sepolia) | `0x036CbD53842c5426634e7929541eC2318f3dCF7e` | Also in `base-sepolia.env.example:7`, `scripts/prepare-testnet-identities.ts:19`, `scripts/probe-base-sepolia.ts:6` and `scripts/persistent-config.ts:4`. |
| Pyth Core (as stated in repo) | `0x5f52e4DBEA21f5b23523B6e20d50c29ae0a4EB83` | `base-sepolia.env.example:10`, `prepare-testnet-identities.ts:22`, `probe-base-sepolia.ts:7`. I did not independently verify it against Pyth's registry, but the docs report live smokes passing against it. |
| Disposable trader | `0x1026b5f8CF4640613B625ECa70b295FfE36E663A` | Testnet EOA. |

**Pyth feed IDs** (`prepare-testnet-identities.ts:28-29`):
- BTC/USD `0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43`
- ETH/USD `0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace`

These are the standard chain-independent Pyth IDs.

**Doc-stated balances:** 25.00016 USDC maker backing, 5.00004 insurance, 9.9998 trader collateral.

**Status (inferred).** This governed stack predates the current code. `scripts/verify-base-sepolia.ts:9` requires `contracts.signatureVerifier` in the manifest, and `:28` calls `exposureState()`. Neither exists on the old implementation, so `npm run verify:base-sepolia` would likely fail against this stack until it is upgraded through the timelock. **No script exists to schedule a governed implementation upgrade.** `upgradeAndCall` appears only in `upgrade-base-sepolia-iteration.ts`, which requires the deployer EOA to own the ProxyAdmin, and in tests.

### 3.2 Base Sepolia. "Iteration" (rapid, deployer-governed) stack (`BASE-SEPOLIA-DEPLOYMENT.md:29-35`)

| Component | Address |
|---|---|
| Iteration clearing proxy | `0x35eDDFfF04296dae1564f4C33518C57C87b91D90` (also `SYSTEM-AUDIT-2026-09-10.md:11`, `VALIDATION-REPORT.md:83`) |
| Iteration Pyth adapter (direct bounded parse) | `0x0d8B76cc87B8289A74021E33E13C9F97Aa2e1873` |
| 2026-09-10 release-candidate implementation | `0xb44Ca37EE72C39a81CCC872C3b9A9c2f000572e4` |
| Its RFQRiskMath | `0x78eA651dA386EC910C8e434097B95e53b7A4D0Fb` |

Upgrade txs are `0x8d5f3c8e…a7307d` (RC activation) and `0xb42dfe25…95d1` (immediate-upgrade test).

- Governance and ProxyAdmin owner are the **deployer EOA** (`deploy-base-sepolia-iteration.ts:9`).
- The emergency council comes from the env, presumably the emergency Safe (inferred).
- Contract code changed on 2026-09-16 (commits `20bbcd2`, `8c5c77c`, `ac12e66`), adding RFQSignatureVerifier and exposure controls. The repo records **no deployed address** for an RFQSignatureVerifier or for an implementation containing exposure controls. The current code's on-chain status is unknown; the real manifest would be in the gitignored `.local-state/base-sepolia-iteration.json`, which is not present in this checkout.

### 3.3 Base mainnet (8453) references

- **USDC `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`.** Hard-coded and enforced in `scripts/mainnet-manifest.ts:16` and `scripts/persistent-config.ts:5`. Also used in `scripts/mainnet-manifest.test.ts:6` and `scripts/persistent-config.test.ts:6`.
- There are no other mainnet addresses in the repo: no Pyth or Chainlink mainnet contracts, no Safes, no timelock. Pyth's Base mainnet contract is commonly `0x8250f4aF4B972684F7b336503E2D6dFeDeB1487a`; that is from outside the repo and must be verified.

---

## 4. Mainnet deploy path: what exists and what is missing

**What exists.** `scripts/mainnet-manifest.ts` (33 lines) validates a JSON manifest and emits an **unsigned plan with `executionAuthorized: false`** (`:28`).

The manifest schema requires:
- `chainId '8453'`, mode `capped-canary`;
- a `candidateHash` matching `identifyCandidate()`;
- the official USDC; distinct roles;
- two distinct feed IDs;
- `timelockSeconds >= 259200`;
- insurance at least 25% of maker capital;
- daily loss limit at most 5% of maker capital;
- per-market `maxTrade*10 <= gross`, `side <= gross`, `net <= gross`, `hedgeBand*20 <= gross`.

**Missing or hard-coded to testnet:**
1. **There is no mainnet deployment executor.** `deploy-base-sepolia.ts:7` hard-requires chainId 84532. `hardhat.config.js` defines only `hardhatOp` and `baseSepolia`. `deployment-config.ts` reads `RFQ_BASE_SEPOLIA_RPC_URL` and caps `RFQ_BASE_RISK_CAPITAL_USDC` at 1,000,000 (`:21`).
2. **Post-deploy policy is never applied.** The plan's `deploymentOrder` (`mainnet-manifest.ts:28`) is RiskMath, SignatureVerifier, implementation, PythCoreAdapter, proxy. `initialize` leaves the clearing **unpaused** with absolute-max caps (1M/trade, 5M/market, 5M gross and side).
   - No plan step sets `setMarketPolicy` from `maxTradeUsdc`/`netUsdc`, or `setExposurePolicy` from `grossUsdc`/`sideUsdc`.
   - `setExposurePolicy` requires paused plus governance, so with a 72h timelock a fresh mainnet proxy would be live at maximum caps for at least 72h.
   - Recommendation: initialize paused, or pass caps into `initialize`.
3. **Some manifest fields have no on-chain enforcement or mapping:** `dailyLossLimitUsdc`, `hedgeBandUsdc` and `insuranceCapitalUsdc` (no `fundInsurance` step). `initialization.makerCapitalUsdc` is presumably `baseRiskCapitalTarget`, but the naming is ambiguous.
4. **The oracle is hard-wired to Pyth** in the plan and in `verify-base-sepolia.ts:23` (`oracleMode!=="pyth"` throws). There are no feed decimals in the mainnet schema and no Chainlink path. The Chainlink adapter's fee handling is unvalidated.
5. **Governance contracts are testnet-only.**
   - `RFQTimelock` lives in `contracts/testnet/` with a hard-coded 3-day delay and the Safe as both proposer and executor.
   - `deploy-testnet-governance.ts` hard-codes `https://sepolia.base.org` (`:9`) and salt nonces `84532001/2`.
   - All Safe owner keys are generated into one local JSON (`prepare-testnet-identities.ts`), and scripts co-sign with two owner keys from the same file (`upgrade-base-sepolia-pyth.ts:38-41`, `finalize-testnet-governance.ts:35-41`). That is fine for testnet but is no real multisig.
   - There is no hardware or Safe-UI ceremony tooling for mainnet.
6. **There is no governed implementation-upgrade script** (timelock `schedule`/`execute` of `ProxyAdmin.upgradeAndCall`), and no governed exposure-migration runbook script. The iteration script requires an EOA ProxyAdmin owner.
7. **There is no source verification (Basescan/Sourcify).** `verify-base-sepolia.ts` only checks code presence and config reads; it never compares bytecode to artifacts.
8. **Upgrade validation compares against a frozen baseline** (`RFQClearingBaseline` from commit 6c04310), not against the layout of whatever implementation is actually live. For the governed Sepolia stack, which runs an older implementation, compatibility is unproven.
9. **`evmVersion` is unpinned** (osaka default) and the 21k gate has 5 bytes of headroom. The mainnet artifact build is therefore fragile.
10. **`preflight-base-sepolia.ts`** requires only 0.001 ETH and checks that addresses have code. There is no mainnet equivalent.

---

## 5. Design assessment, risks and test gaps

### 5.1 Sound decisions

- **Three-signature model.** User intent plus 2-of-3 independent approvers, with exact oracle-report binding and version fencing that is not in the user signature. This is a clean RFQ-with-guardrails design. The sender has no authority, which suits gas sponsorship.
- **On-chain inventory-impact pricing floor.** `deliveredImpact >= impactCharge >= impactCost` means approvers cannot sign below the convex inventory charge. Combined with exposure, stress and capital checks, it bounds the damage from compromised approvers.
- **Conservative margin and liquidation rules.** Opening margin ignores positive unrealized PnL. Longs are marked at bid and shorts at ask. Portfolio bankruptcy is netted. Insurance is used only after an account-wide default. These are careful accounting choices.
- **Custody reconciliation.** Exact-pull deposits, and the `stateful-clearing-e2e` invariant that buckets equal token balance.
- **Exits that need no approvers.** Paused-market owner close at the oracle side, with sponsored variants, plus permissionless liquidation and resolution.
- **Authority split.** The emergency council can only tighten.
- **Upgrade discipline.** A transparent proxy with the ProxyAdmin under a timelock, plus storage-layout validation in CI.

### 5.2 Security concerns and bugs (my severity estimates)

1. **Oracle observations are not monotonic, and keepers can cherry-pick them (medium).**
   - `_recordObservation` (`:528-530`) overwrites `lastBid/lastAsk/lastPriceTime` with any report at most 15s old, even one older than the stored one.
   - A liquidator can pick, for every leg, the most adverse authenticated price in the trailing 15s window: the report passed to `liquidate`, and any report pushed into the other leg through `refreshOracle`. Pyth publishes many updates per window (inferred).
   - Fix: require `o.observedAt >= market.lastPriceTime` on record.
2. **Resolution price sampling is also selectable (medium).**
   - `submitResolutionObservation` (`:410-428`) accepts the **first** three reports after the trigger, with no upper bound on delay and only a 30s span between the first and third.
   - The first submitter chooses both timing and sample points, among many valid updates. With only three samples, the median is easy to steer within the window's volatility.
   - Consider TWAP-style sampling over fixed time buckets, or bounded windows relative to the trigger.
3. **Anyone can push the whole venue into terminal resolution (design risk, medium).**
   - `declareResolution` is permissionless whenever `makerIncident` holds (`RFQRiskMath.sol:151-155`): open exposure AND (backing below `baseRiskCapitalTarget` OR stress above backing/4).
   - Ordinary market moves that drain maker backing below the configured floor let any griefer end the venue permanently. Resolution has no exit path except an upgrade.
   - The floor is an *opening* threshold, so it is very conservative to also use it as an irreversible kill switch.
   - Consider a grace period, a separate lower threshold, or having it auto-pause rather than resolve.
4. **Funds are stuck after resolution (medium).**
   - `processResolution` zeroes the maker and insurance buckets and sets `resolutionAssets = balanceOf`.
   - Claims are capped at 100%, so any surplus (assets above claims) is permanently locked. Maker capital is not returned.
   - If `totalResolutionClaims == 0`, everything is locked (`claimResolution` reverts at `:450`).
   - There is no sweep for insurance or maker capital, and no rescue for ETH sent to payable functions with an adapter that does not consume it. The Pyth adapter rejects inexact fees; `MockPriceOracle` and the Chainlink path forward `msg.value` (inferred).
5. **Changing the funding denominator applies retroactively (low/medium).** `setMarketPolicy` (`:366`) changes `maxMarketNotional`, the funding APR denominator, without first calling `_updateFunding`, so the new rate is applied to the elapsed interval. Emergency tightening therefore raises funding retroactively.
6. **Risk-reducing partial trades are blocked between IM and MM (low/medium, UX and safety).** `_applyAuthorizedTrade` (`:282`) requires `openingEquity >= initialMargin` for **all** trades, including `reduceOnly`. An account whose equity is between maintenance and initial margin cannot partially de-risk through RFQ; only a full close or liquidation works (inferred from code; no test covers it).
7. **Session-key hijack griefing (low).** `_setSession` (`:548`) overwrites `sessions[session]` regardless of the existing owner. Any account can sign a grant naming another user's session-key address (public in the `SessionGranted` event) and redirect it to themselves. This breaks the victim's session (DoS only, no fund loss). Fix: require `sessions[session].account == 0 || == grant.account`.
8. **Oracle outage locks funds behind the 72h timelock.**
   - Withdrawals with open positions need fresh prices (`_requireFreshPositions`).
   - Owner close needs a report and a pause.
   - Resolution needs 3 reports per market.
   - Replacing the oracle is governance-only (72h). The emergency council has no oracle fallback.
9. **Emergency actions are asymmetric.** `pause()` (emergency) can be undone only by `unpause()` (governance, 72h), so any precautionary pause costs at least 72h of downtime. Approver rotation is also governance-only. This is intended, but it should be explicitly accepted in the operational SLOs.
10. **The Chainlink adapter is untested against reality.** Empty `parameterPayload`, no fee handling, `validFromTimestamp` ignored, and it would trap ETH if the verifier refunds (inferred). Treat it as non-functional until validated on a fork.
11. **The Pyth confidence interval is used as BBO** (`PythCoreAdapter.sol:56-62`). `conf` is not executable liquidity, so liquidation and close prices are near mid. This is acceptable for the clearing function, but it understates exit costs in stress (economic risk).
12. **Liveness depends on keepers.**
    - Every trade needs **all markets with gross exposure** fresh within 15s (`RFQRiskMath.sol:56`).
    - The API pays Pyth fees and gas to refresh the other market when it is more than 8s stale (`services/api/src/server.ts:267`).
    - The design is fail-closed but chatty.
    - There is no batched multicall (`refreshOracle` plus `withdraw`) for users.
13. **Hard-coded literals duplicate contract constants:** `15` in `RFQRiskMath.sol:56,143` and `PythCoreAdapter.sol:46,61`; `5_000_000e6` in `RFQRiskMath.sol:22,25`; the margin tiers. A policy change means a code upgrade, and the copies can drift.
14. **Naming and errors.** Reused error types (`Replay` for a fee-cap breach), opaque `InvalidTrade`, and few events for admin actions hamper monitoring.
15. **Gas and scale (inferred).**
    - `_accountList` only grows. Resolution and migration iterate all ever-registered accounts. The 10 USDC minimum first deposit is the only anti-spam measure.
    - `nonceUsed` is a bitmap-less mapping, which costs a full slot per nonce.

### 5.3 Over- and under-engineering

**Over-engineered:**
- `RFQAuthorization.sol` and `RFQInvariants.sol` are dead reference code with a divergent typehash, yet they are compiled, tested and shipped in artifacts.
- Two linked libraries plus a byte-golfed core (one-line functions, packed `marketLimitWord`, tiny error set) exist purely to stay under a self-imposed 21k gate. The result is very hard-to-read Solidity, e.g. `RFQSignatureVerifier.sol` is minified onto single lines.
- The off-chain gross-reservation machinery is elaborate for a 2-market canary.

**Under-engineered:**
- no mainnet deployment, governance or verification tooling;
- no governed upgrade script;
- no oracle fallback;
- no exit from resolution;
- no sweep of surplus;
- no ADL or partial socialization short of global resolution;
- only 2 markets, hard-coded into storage (`Market[2]`, `uint8[2]`), so adding a market requires a storage-layout-changing upgrade.

### 5.4 Test coverage gaps

The tests are Hardhat 3 `hardhat run` scripts with ad-hoc `assert`. There is no test runner (no mocha or describe), no coverage, no gas reports and no fuzzing.

1. **No property-based fuzzing or invariant testing of RFQClearing.**
   - `RFQInvariants.sol` targets the dead `RFQAuthorization`.
   - The "fuzz" in `contract-e2e.mjs:73-83` is 200 deterministic calls.
   - `risk-differential.mjs` is a line-by-line JS transliteration of the Solidity (not an independent spec) over 1500 seeded vectors.
   - `stateful-clearing-e2e.mjs` is one seeded random walk (600 steps, 4 traders, no liquidations, no funding stress).
2. **Rejection tests don't assert the reason.** `reject()` and `mustReject()` (`clearing-e2e.mjs:16-20`, `contract-e2e.mjs:59-63`) catch any error, and most `assert.rejects` calls have no error matcher. A test can pass for the wrong reason (for example a stale price rather than the intended auth failure).
3. **Untested cases:**
   - oracle non-monotonic overwrite;
   - session-key overwrite by another account;
   - reduce-only trade in the IM–MM band;
   - `setMarketPolicy` retroactive funding;
   - resolution with assets above claims or zero claims;
   - `depositWithAuthorization` with real EIP-3009 signatures (MockUSDC ignores signatures);
   - Chainlink adapter fee path;
   - `withdrawMakerExcess` under stress;
   - `rotateApprovers` and `setOracle` flows;
   - `processResolution` and `migrateExposure` gas at scale (thousands of accounts);
   - reentrancy with a malicious oracle or token;
   - EIP-7702 accounts;
   - partial liquidation repeated to convergence.
4. **No fork tests** against the real Pyth contract or real USDC (EIP-3009, blacklist, pause).
5. **No coverage metric. No Slither, Aderyn or Mythril static analysis** in CI. There is also no formal verification of the conservation invariant.

---

## 6. Tooling: Hardhat 3 plus custom solc script vs Foundry

**Current setup.**
- `hardhat.config.js` declares only networks. There is **no `solidity` config**, so Hardhat's build system is bypassed.
- `scripts/compile-contracts.mjs` uses **solc-js 0.8.34 (emscripten WASM)**. It is about 4x slower than native: 58s for the full set; 15s for the core alone in my experiment.
- It hand-lists 18 source files (`:6-24`); a new file is silently omitted unless added.
- It writes a fake `hh3-sol-build-info-1` build-info so `@openzeppelin/upgrades-core validate` works.
- Library linking is done manually (`scripts/link-artifact.mjs`).
- Tests use `hardhat run --network hardhatOp` (EDR with OP chain type) as a node plus ethers v6.

**Assessment.** It works and is reproducible because solc is pinned through npm. But it re-implements what Hardhat 3 and Foundry already do (artifact layout, linking, build-info), skips Hardhat's caching, and uses the slow WASM compiler.

**Recommendations:**
1. **Add Foundry alongside the existing setup.**
   - `forge` with native solc, pinned `evm_version`, and `via_ir = true`.
   - Use `forge test` for unit, fuzz and **stateful invariant** tests (handler-based) over RFQClearing, with invariants such as:
     - `makerBacking + insurance + totalCustomerCollateral == usdc.balanceOf`;
     - `sum(long) - sum(short) == aggregateBase`;
     - no nonce reuse;
     - no trade while paused;
     - resolution claims at most assets.
   - Use `forge coverage`, `forge snapshot` for gas, `--fork-url` for Base mainnet fork tests against real Pyth and USDC, and `forge script` with Safe or Ledger signers for deployments.
   - Use `forge verify-contract`.
   - Optionally add Echidna or Medusa, and Halmos for the pure math in RFQRiskMath.
2. **Or, staying with Hardhat 3:** configure `solidity: { version: "0.8.34", settings: { viaIR: true, optimizer: { runs: 1 }, evmVersion: "cancun" } }` and use Hardhat's native compiler download and caching. Use `hardhat-ignition` for deterministic deployments (it handles library linking and the predicted-address issue). Use the built-in `node:test` or mocha runner with `revertedWithCustomError` matchers.
3. **Pin `evmVersion`.**
4. **Raise or rework the bytecode gate**, so a solc bump is not blocked by 5 bytes.
5. **Add Slither to CI.** Add `@openzeppelin/hardhat-upgrades` or the Foundry `openzeppelin-foundry-upgrades` plugin so validation runs against the actual deployed implementation's layout, not only a frozen baseline.
6. **Source-verify** all implementations and libraries on Basescan or Sourcify.

---

## 7. Refactor and DRY opportunities

**Contracts:**
1. Delete or move `RFQAuthorization.sol` and `RFQInvariants.sol` out of the build. Replace them with Foundry invariants over RFQClearing. Remove the unused constants in `RFQClearing.sol:24-53` and `RFQRiskMath.enforceAggregateRisk` (`:147-150`).
2. Put the EIP-712 typehashes and domain in one place: a shared `RFQTypes.sol` file-level constants file, or only in RFQSignatureVerifier. Move the withdrawal, cancel, close and session-grant digest construction into the verifier too. This frees bytes in RFQClearing.
3. Name the shared constants (`MAX_ORACLE_AGE`, `ABSOLUTE_MAX_*`, the scale `1e18`) in one file-level constants file used by both libraries and the adapters, instead of literals `15`, `5_000_000e6` and `1e18`.
4. Use one oracle-touch helper. The pattern `_verifyReport → _recordObservation → _updateFunding(mid)` repeats at `:213-215`, `:262-264`, `:292-293` and `:495-497`. A single `_touchOracle(report, market)` that also enforces monotonicity would replace it.
5. Use one "settle all funding, return early on resolution" helper. It repeats across `liquidate`, `_withdraw` and `executeTrade`, each with its own `if (resolutionRequired) return;` checks at `:266`, `:277`, `:299`, `:313`, `:318`, `:486`, `:499` and `:504`. A pattern that returns a status would be clearer.
6. Replace `Market[2]` and the fixed arrays with a mapping keyed by market ID, plus a `marketCount`, at the next layout-breaking redesign. Optionally use OZ `NoncesKeyed` or a bitmap nonces implementation.
7. Format the code. `RFQSignatureVerifier.sol` and parts of `RFQRiskMath.sol` are minified; under via-IR, readability costs no bytecode.

**Scripts:**
1. **Six e2e scripts and the deploy scripts each re-implement the same scaffolding:**
   - `artifact(name)` loader;
   - `deploy()` with `linkArtifact`;
   - the RiskMath, SignatureVerifier, implementation, proxy deploy order;
   - the EIP-712 `domain`, `intentTypes` and `approvalTypes` literals (copied in `clearing-e2e.mjs:118-143`, `bankruptcy-e2e.mjs:17-18`, `exposure-e2e.mjs:17-18` and `stateful-clearing-e2e.mjs:27-33`);
   - the `observation`/`report` encoder;
   - the ADMIN_SLOT and IMPLEMENTATION_SLOT constants;
   - the `reject` helper.

   Extract these into `scripts/lib/contract-fixture.mjs`, or reuse whatever shared typed-data definitions `packages/` may already have (inferred).
2. **One deploy routine** parameterized by network, governance mode and oracle mode, replacing the separate `deploy-local.ts`, `deploy-base-sepolia.ts` and iteration wrapper. Also add a mainnet executor that consumes the `mainnet-manifest` plan.
3. **One Safe-execution helper.** The Safe co-signing code is duplicated in `upgrade-base-sepolia-pyth.ts:36-42` and `finalize-testnet-governance.ts:34-43`. Also add a generic `timelock-op.ts` (schedule, wait, execute any call) and use it for upgrades, `setOracle` and policy changes.
4. **One "wait for code / wait for RPC convergence" helper.** Polling loops appear at `deploy-base-sepolia.ts:13-17`, `:25`, `upgrade-base-sepolia-iteration.ts:17,31,37`, `deploy-testnet-governance.ts:21` and `upgrade-base-sepolia-pyth.ts:27`.
5. **Remove repeated hard-coded RPC endpoints.** `https://sepolia.base.org` appears in `deploy-testnet-governance.ts:9,14,21`, `finalize-testnet-governance.ts:12` and `verify-base-sepolia.ts:8`.
6. **Derive `compile-contracts.mjs` sources from a glob** of `contracts/**/*.sol` instead of the hand-maintained list. Gate every deployable contract's size, not only RFQClearing.
