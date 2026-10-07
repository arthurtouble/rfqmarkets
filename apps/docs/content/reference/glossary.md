# Glossary

**Account value.** Your equity, as the app labels it.

**Approver.** One of three keys that independently check and co-sign every trade. Two signatures are required. See [Approvers](../protocol/approvers.md).

**Available to trade.** Opening equity minus initial margin. How much more margin you can commit, and how much you can withdraw. Sometimes called available margin.

**Base.** The Ethereum layer-2 network the venue settles on. Chain id 8453.

**Basis point (bp).** One hundredth of a percent. 8 bps is 0.08%.

**Clearing contract.** The smart contract that holds all collateral and positions and enforces every rule.

**Collateral.** The USDC credited to your account.

**Emergency council.** A role that can pause trading and tighten limits immediately, but cannot loosen anything or move funds.

**Entry price.** The average price of your open position.

**Epoch (leader epoch).** A counter in the contract. Advancing it invalidates every outstanding approval.

**Equity.** Collateral plus unrealized profit and loss. *Maintenance equity* counts all of it; *opening equity* counts losses only.

**Firm quote.** The price the maker commits to for your exact size when you click. Valid for about ten seconds.

**Funding.** A continuous payment from the crowded side of a market to the other side. See [Funding](../risk/funding.md).

**Governance.** The role that can upgrade the contracts and change markets, limits and keys. A single key on the development deployment.

**Gross limit, side limit, net limit.** Caps on traders' total long plus short, on each side, and on long minus short, per market.

**Hedger.** The service that offsets the maker's net exposure on an external venue. Simulated on the development deployment.

**Indicative quote.** The estimated price the ticket shows as you type. Nothing is reserved.

**Initial margin.** The margin needed to open risk or withdraw. For BTC and ETH today, 5% of notional for positions up to 25,000 USDC, which allows 20x. Each market's rates are its base schedule times a multiplier set by governance.

**Insurance fund.** Capital, built from fees and penalties, that covers bankrupt accounts before the maker's capital does.

**Intent.** A signed message stating exactly what you authorize, such as a *TradeIntent* or *WithdrawalIntent*.

**Inventory adjustment (impact charge).** The part of the price that reflects how your trade changes the maker's net position.

**Keeper.** Anyone who calls permissionless maintenance functions, such as liquidation, for a reward.

**Leverage.** The total notional of your positions divided by your account value. Up to 20x on BTC and ETH today.

**Liquidation.** Closing an account's positions when its equity falls below maintenance margin.

**Maintenance margin.** The minimum margin you must keep: 3% of notional for BTC and ETH positions up to 25,000 USDC.

**Maker.** The venue's market maker, counterparty to every trade.

**Mark.** The price a position is valued at: the oracle bid for longs, the ask for shorts.

**Nonce.** A number that makes each signed message usable once.

**Notional.** The size of a position in USDC: size times price.

**One-click trading.** A session key that signs market orders and closes for you within contract-enforced limits. Formerly called quick trading. See [One-click trading](../trading/one-click-trading.md).

**Oracle.** Three nodes that sign aggregated exchange prices, and the contract that accepts a report from at least two of them. See [Price oracle](../markets/price-oracle.md).

**Pause.** A state in which new trades are blocked but closing at the oracle price, withdrawals and liquidations continue.

**Price protection.** The worst price you sign. The app uses 8 bps beyond the firm quote; the API accepts 1 to 500 bps.

**Reduce only.** A flag that lets a trade only shrink a position, never grow or flip it.

**Resolution.** The venue's wind-down if the maker cannot cover its obligations: fixed prices, then pro-rata payouts. See [Safety and exits](../protocol/safety-and-exits.md#resolution).

**RFQ.** Request for quote: asking a market maker for a firm price for a specific size.

**Session key.** See *One-click trading*.

**Simple and Advanced.** The app's two views. Advanced adds limit orders, reduce only and price details.

**Skew.** Traders' net position in a market, long minus short.

**Slippage.** How far the fill price may move past the quote before a trade is refused. Set by the price protection.

**Spread.** The maker's margin over the oracle price, in basis points. Adaptive; 2 bps at its base.

**Stop loss, take profit, stop entry.** Orders that wait for the oracle mid to cross a trigger price and then trade within a signed band. See [Stop loss and take profit](../trading/stop-orders.md).

**Stress loss.** The maker's estimated loss if every market moved sharply against it at once. Kept below a quarter of its capital.

**USDC.** The dollar stablecoin used for all collateral and settlement; specifically Circle's native USDC on Base.
