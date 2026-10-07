# On-chain data

Everything that matters about your account and the venue can be read straight from the clearing contract on Base, without the venue's API. This page lists the useful views and events.

## Units

| Quantity | Unit |
| --- | --- |
| USDC amounts | 6 decimals |
| Position sizes | 18 decimals of BTC or ETH |
| Prices | USDC with 6 decimals, per whole BTC or ETH |
| Notional | size × price ÷ 10¹⁸, in USDC with 6 decimals |
| Rates (funding, impact) | 10¹² is 100% |

Market ids are 0 for BTC and 1 for ETH. Requirements and profit are rounded down; amounts the contract takes from you to protect others, such as stress and liquidation size, are rounded up.

## Account views

| Function | Returns |
| --- | --- |
| `collateralOf(account)` | Collateral in USDC. Can be negative only briefly inside a liquidation. |
| `positionOf(account, market)` | Size (signed, 18 decimals), entry price and the funding index the position was last settled at. |
| `openMarketsOf(account)` | Which markets the account has positions in. |
| `maintenanceEquity(account)` | Collateral plus all profit and loss at the stored oracle prices. |
| `openingEquity(account)` | The same, counting only losing positions. |
| `initialMargin(account)` / `maintenanceMargin(account)` | The account's requirements. |
| `nonceUsed(account, nonce)` | Whether a nonce has been used or cancelled. |
| `sessions(session)` | A session key's account, limits, expiry and usage so far. |

`maintenanceEquity` and `openingEquity` use the last stored oracle prices and do not include funding accrued since the account was last settled. The API's `/v1/account` view includes both.

## Venue views

| Function | Returns |
| --- | --- |
| `markets(market)` | Traders' net position, the funding index and when it last moved, the last stored oracle bid and ask and their time, and whether the market is enabled. |
| `marketCount()` / `marketId(symbol)` | How many markets exist, and a market's id from its symbol. |
| `marketLimits(market)` | The maximum trade and the net limit. |
| `exposureState(market)` | Traders' total long and short in base units, and the gross limit (low 128 bits) and side limit (high 128 bits). |
| `marketParams(market)` | Inventory pricing coefficient, stress shock and margin multiplier. |
| `portfolioStress()` | The maker's estimated loss under the stress shocks. |
| `customerUnrealizedGain()` | Traders' total unrealized gains at mid. |
| `makerBacking()`, `insuranceBalance()`, `baseRiskCapitalTarget()` | The maker's capital, the insurance fund and the maker's capital target. |
| `makerIncident()`, `makerIncidentSince()` | Whether the maker's capital is currently below its safety thresholds, and when an incident was reported. |
| `paused()` / `resolutionRequired()` | The venue's state. |
| `leaderEpoch()`, `signerSetVersion()`, `policyVersion()` | The current approval versions. |
| `oracle()`, `governance()`, `emergencyCouncil()`, `approvers(i)` | Who holds each role. |

## Events

Trading and accounts:

| Event | Emitted when |
| --- | --- |
| `Deposited(account, amount)` | Collateral is deposited. |
| `Withdrawn(account, amount)` | Collateral is withdrawn. |
| `TradeExecuted(intentHash, account, market, baseDelta, price, fee)` | A trade settles. `intentHash` and `account` are indexed. |
| `FundingSettled(account, market, payment)` | Funding is settled into collateral. A positive payment was paid by the account. |
| `PositionClosed(account, market, baseDelta, price)` | A position is closed at the oracle price: a paused close, or a bankrupt account's full close. |
| `Liquidated(account, market, closedBase, penalty, keeperReward)` | A liquidation. |
| `DeficitAbsorbed(account, insuranceUsed, makerUsed, unresolved)` | A bankrupt account's loss is covered. |
| `NonceCancelled(account, nonce)` | A nonce is cancelled. |
| `SessionGranted(account, session, validUntil, maxCumulativeNotional)` / `SessionRevoked(account, session)` | Quick-trading sessions. |

Capital and governance:

| Event | Emitted when |
| --- | --- |
| `MakerFunded`, `InsuranceFunded`, `MakerWithdrawn` | Maker capital or insurance changes. |
| `PauseChanged(paused)`, `EpochAdvanced(epoch)` | Pausing, unpausing and approval fencing. |
| `MarketAdded(market, symbol)`, `MarketPolicyUpdated`, `ExposurePolicyUpdated`, `MarketRiskUpdated` | Market listings and parameter changes. |
| `OracleUpdated`, `ApproversRotated(approvers, signerSetVersion)` | Oracle or approver changes. |
| `GovernanceTransferStarted`, `GovernanceTransferred`, `EmergencyCouncilUpdated` | Changes of authority. |
| `MakerIncidentReported(since)`, `MakerIncidentCleared` | Maker incidents. |
| `ResolutionStarted`, `ResolutionPriceReady`, `ResolutionFinalized`, `ResolutionClaimed` | Resolution. |

The oracle contract also emits `MarketSkipped(market, reason)` when it leaves a market out of a report: reason 1 means the nodes disagreed, 2 means the price jumped too far.

## Permissionless functions

These need no special role. Anyone can call them:

| Function | Purpose |
| --- | --- |
| `refreshOracle(report)` | Records a fresh oracle report and accrues funding. Useful before a direct withdrawal with open positions. |
| `liquidate(account, market, report)` | Liquidates a qualifying account and pays the caller a reward. |
| `fundMaker(amount)` / `fundInsurance(amount)` | Adds capital. |
| `reportMakerIncident()` / `clearMakerIncident()` | Starts or clears the grace period. |
| `declareResolution()` | After an incident's grace period. |
| `submitResolutionObservation(report)`, `processResolution(maxAccounts)`, `addResolutionRecovery(amount)` | Drive a resolution forward. |

Oracle reports are passed as raw bytes. Calls that take one must send no ETH. See [Oracle feeds](oracle-feeds.md#building-a-report).

## Account-owner functions

Sent by the account itself, paying its own gas: `deposit(amount)`, `withdraw(amount)`, `cancelNonce(nonce)`, `revokeSession(session)`, `closePosition(market, report)` (paused only) and `claimResolution()`. These are what the [exit page](../protocol/safety-and-exits.md#the-exit-page) calls.
