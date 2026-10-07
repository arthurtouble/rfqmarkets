# Price oracle

Every trade, liquidation and funding payment on RFQ Markets is priced from the venue's own oracle. It is built so that no single exchange, server or key can move the price the contract uses.

## Three nodes

The oracle is three independent price nodes, each running in a different region: western North America, western Europe and Asia-Pacific. Each node has its own signing key, generated inside it and never exported.

Every second, each node:

1. **Collects top-of-book prices** for each market from seven exchanges: Coinbase, Kraken, Bitstamp, Gemini, OKX, Bybit and Binance, over live streams with a fallback to their public APIs.
2. **Converts every quote to USDC.** Exchanges quote in USD, USDT or USDC, so the node measures USDT and USDC against the dollar from several exchanges and converts each quote. A stablecoin rate needs at least two fresh sources and must be within 5% of a dollar, or that exchange is dropped.
3. **Discards bad quotes**: anything older than 2 seconds, crossed, or wider than 1%.
4. **Takes the median** of the exchanges' mid prices, drops any exchange more than 0.5% away from it, and takes the median again.
5. **Requires at least three exchanges** to agree. With fewer, the node publishes no price for that market.
6. **Sets a bid and ask** around the median, as wide as the furthest surviving exchange is from it, and refuses to publish if that width exceeds 1%.
7. **Signs the result** as one batch for all markets, with the time of observation.

So the oracle's bid-ask width is a measure of how much the exchanges disagree, not anybody's order book. In calm markets it is a basis point or two.

## Two of three

A price report that the contract will accept must contain signed batches from at least **two of the three** nodes, observed within 5 seconds of each other. The on-chain oracle contract checks the signatures and then, for each market:

- requires prices from at least two nodes;
- requires the nodes' mid prices to be within 0.5% of each other, and skips the market otherwise;
- takes the median bid and median ask across the nodes.

One node can be down, slow or wrong without affecting the price. Two nodes would have to agree on a false price for it to reach the contract, and even then the trade must also pass the approvers' and the contract's own checks.

## Freshness

| Check | Limit |
| --- | --- |
| Venue quote used by a node | at most 2 seconds old |
| Report used by an approver to co-sign a trade | at most 8 seconds old |
| Report accepted by the contract | at most 15 seconds old |
| Bid-ask width accepted by the contract | at most 1% |

The contract also only ever moves stored prices forward in time: a report older than the one already recorded is ignored. That stops anyone from settling against an older, more favourable price that happens to still be within its validity window.

If no fresh report is available, for example because two nodes are down, the contract refuses trades, withdrawals that depend on open positions, and liquidations. Nothing is priced on a stale or substitute price. Deposits, cancellations and withdrawals with no open positions keep working.

## Checking a price yourself

Each node keeps every batch it signed for 30 days, with its signature, and one-minute candles permanently. Anyone can fetch them and check that the price of any trade matches prices the nodes actually signed. See [Oracle feeds](../integrate/oracle-feeds.md) for the endpoints and the signature format.

## Why not a third-party oracle

The venue started on Pyth and replaced it in October 2026 with its own nodes. Commercial low-latency feeds charge per asset and per month, which made a long list of markets expensive, and the venue needs one consistent design for every market it lists. Running its own nodes adds an operational dependency on the venue, which the two-of-three design, the public signed history and the contract's checks are there to contain.
