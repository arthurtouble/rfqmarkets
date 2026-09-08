# RFQ Markets — design research synthesis

2026-09-08. Primary protocol documentation, public source and selected market-making literature used for version 0.1. A documented mechanism is evidence of a design pattern, not proof that it is safe for this protocol or every deployment of the referenced system.

| Source | Useful method | Adopted here | Deliberately not copied |
| --- | --- | --- | --- |
| Avellaneda–Stoikov, *High-frequency trading in a limit order book* | Inventory changes a dealer's reservation price; volatility and inventory affect quote placement. | Inventory-aware fair value, latency/volatility spread input and simulation-first calibration. | Brownian/Poisson assumptions as a production risk model; their model is not a leveraged clearinghouse. [Paper](https://www.researchgate.net/publication/24086205_High_Frequency_Trading_in_a_Limit_Order_Book) |
| Convex cost-function literature | A trade can be charged as the difference of one potential before/after the trade, giving path-independent cumulative cost under fixed state/parameters. | `C(x+d)-C(x)` for split resistance and a positive-semidefinite multi-market candidate. | Prediction-market loss bounds or CFMM reserve claims, which do not directly apply to perpetual liabilities. [Chen & Vaughan](https://arxiv.org/abs/1003.0034) |
| Synthetix Perps | Initial/final skew affects fill price; funding responds to imbalance. | Starting/ending inventory impact and skew funding principle. | Assuming funding eliminates exposure or copying deployment parameters. [Price impact](https://blog.synthetix.io/price-impact-function-synthetix-perps/) |
| GMX | Impact from change in imbalance; caps on favorable impact; virtual inventory for correlated markets; layered OI/reserve/ADL protections. | Cross-market virtual exposure, cumulative impact, bounded credits and independent gross/stress caps. | Current market-specific zero-impact/capped settings and delayed rebate machinery. [Fees and price impact](https://docs.gmx.io/docs/trading/fees/), [protocol protections](https://docs.gmx.io/docs/providing-liquidity/#protocol-protections) |
| Hyperliquid | Size-sensitive margin tiers; full/partial liquidation; backstop liquidation; ADL as last resort; robust mark/oracle separation. | Conservative size tiers, bounded partial liquidation and explicit terminal loss handling. | Validator consensus, extreme leverage, order-book liquidation and hidden automatic ADL. [Margin tiers](https://hyperliquid.gitbook.io/hyperliquid-docs/trading/margin-tiers), [liquidations](https://hyperliquid.gitbook.io/hyperliquid-docs/trading/liquidations), [ADL](https://hyperliquid.gitbook.io/hyperliquid-docs/trading/auto-deleveraging) |
| Drift | Initial/maintenance margin parameters, size IMF and limited positive unrealized-PnL credit for new risk; incentivized keepers. | No positive-uPnL credit for v1 opening/withdrawal, increasing size tiers and keeper reward funded by penalty. | Solana-specific execution and current protocol parameter values. [Margin](https://docs.drift.trade/protocol/trading/margin), [keeper incentives](https://docs.drift.trade/protocol/about-v3/keepers/keeper-incentives) |
| dYdX Chain | Liquidation execution support, insurance and deleveraging when accounts become negative. | Explicit bankruptcy detection, insurance layer and non-first-come terminal resolution. | Random counterparty selection and protocol-specific order-book mechanics. [Loss mechanisms](https://help.dydx.trade/en/articles/166973-contract-loss-mechanisms-on-dydx-chain) |
| Hashflow / 0x RFQ | Exact off-chain maker authorization bound to trader/order details, nonce, expiry and chain; registered maker signers. | Exact maker approval digest, short validity, signer versions and contract replay checks. | Treating maker signature as proof of fair value, or relying on one hot signer. [Hashflow API](https://docs.hashflow.com/hashflow/market-making/getting-started-api-v3), [0x orders](https://docs.0xprotocol.org/en/latest/basics/orders.html) |
| CoW Protocol | User intent is distinct from solver settlement; contract enforces user price/expiry/signature constraints. | User market-with-protection intent and server-submitted execution. | Batch auctions and solver competition, which conflict with the simple immediate sole-maker path. [Settlement](https://docs.cow.fi/cow-protocol/reference/contracts/core/settlement) |
| Chainlink Data Streams | Authenticated report identity, observation time, expiry, price, bid and ask. | Directional reference, explicit freshness and deterministic eligibility modes. | Equating report expiry with trading freshness or letting callers select historical reports. [Schema](https://docs.chain.link/data-streams/reference/report-schema-v3) |
| Base Flashblocks | Pending-state calls/simulation and approximately 200 ms preconfirmation events. | Fast provisional UI and pre-submit simulation while retaining sealed/final reconciliation. | Calling a preconfirmation irreversible finality. [Overview](https://docs.base.org/base-chain/api-reference/flashblocks-api/flashblocks-api-overview) |
| Circle FiatToken | EIP-2612 permits and EIP-3009 transfer authorization with relayed execution. | Exact, short-lived sponsored USDC deposit candidate after deployed-bytecode compatibility checks. | Unlimited approvals or assuming all smart wallets behave identically. [Token design](https://github.com/circlefin/stablecoin-evm/blob/master/doc/tokendesign.md) |
| OpenZeppelin | Stable proxy pattern, role separation and delayed administration. | One stable clearing proxy, self-administered timelock, narrow emergency role and migration tests. | Unrestricted proxy admin or an emergency upgrade bypass. [Proxy pattern](https://docs.openzeppelin.com/upgrades-plugins/proxies), [access control](https://docs.openzeppelin.com/contracts/5.x/access-control) |

## Resulting design position

The combined design does not claim decentralization from three operator signers. Base supplies transaction ordering; Chainlink supplies authenticated market observations; two-of-three approvers protect maker authorization; contracts enforce current financial state; the operator supplies capital and external hedging.

The most important synthesis is layered rather than redundant:

1. User limits protect the customer.
2. Inventory-aware off-chain pricing protects quote quality.
3. Independent approvers protect against one compromised quoter/signer.
4. Current-state contract bounds protect against ordering, Sybil splitting and a malicious API.
5. Margin, caps, insurance and terminal resolution protect solvency.
6. Hedging reduces economic exposure but is never assumed to be Base collateral.

No cited protocol proves our parameter choices. Version 0.1 values are hypotheses for executable testing.

