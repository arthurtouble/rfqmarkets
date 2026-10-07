# Markets and limits

RFQ Markets lists linear perpetual futures settled in USDC. Each market tracks one asset's price around the clock, with no expiry and no session close.

## Current markets

| Market | Asset | Opened | Hours | Maximum leverage |
| --- | --- | --- | --- | ---: |
| BTC | Bitcoin, priced in USDC | October 2026 | 24/7 | 20x |
| ETH | Ether, priced in USDC | October 2026 | 24/7 | 20x |

Positions are sized in the asset (BTC or ETH) and valued in USDC. A profit or loss is the position size times the price change, paid in USDC.

The app reads the list of markets from the venue each time it loads, so a market governance lists appears in the app, in the market switcher and on the Markets page, without a new release. To see what is listed right now, look at the Markets page or call `GET /v1/config`.

## Only 24/7 markets

The venue lists only assets that have liquid, continuous prices every hour of every day. That rules out, for now, anything whose reference market closes overnight or at weekends, such as ordinary stocks. The reason is safety: if the reference price stops, positions cannot be marked, liquidated or closed fairly, and a market that reopens after a gap can jump past every trader's stop.

More crypto markets are planned. Stock markets may follow once there are several independent sources of 24/7 prices for them, such as tokenized stocks and the stock perpetuals some exchanges now list. A single source will not be enough.

## Limits

The maker is the counterparty to every trade, so the venue caps how much risk it can take on. These limits are enforced by the contract and checked independently by every approver.

| Limit | What it caps | Today, per market |
| --- | --- | ---: |
| **Maximum trade** | The notional of a single trade | 25 USDC |
| **Net limit** | Traders' total net position, long minus short | 100 USDC |
| **Side limit** | Traders' total long, or total short | 150 USDC |
| **Gross limit** | Traders' total long plus total short | 200 USDC |

There are also venue-wide checks:

- **Stress.** The contract estimates the maker's loss if every market moved sharply against it at once (40% for BTC and 50% for ETH today) and refuses new risk if that loss would exceed a quarter of the maker's capital.
- **Capital floor.** New risk is refused if the maker's capital is below its target.

There is no per-account position limit beyond these. Your own size is limited by your margin.

### What happens at a limit

Limits only ever block trades that make the limited quantity worse. A trade that reduces the maker's exposure is accepted even when a limit is exceeded, so you can always close. When a market is near its limits, the ticket's button may read **Long is closed right now** (or Short) while trades in the other direction still go through.

The venue also applies tighter, temporary limits of its own when its hedging falls behind (see [Hedging](../protocol/hedging.md)): first halving the maximum trade size, then allowing only exposure-reducing trades. A banner above the ticket says so when that happens: "Trade sizes are smaller than usual while our hedge catches up", then "Only closing trades right now".

## Changing markets and limits

Markets are held in an on-chain registry, and governance can change them without upgrading the contract:

- **List a new market**, with its symbol, limits and risk parameters. The registry holds up to 128 markets. A new market can trade once at least two of the three oracle nodes are pricing it and the maker has a hedge set up for it; until the hedge exists, the market accepts only trades that reduce positions.
- **Change a market's limits**: the maximum trade, the net, side and gross limits.
- **Retune a market's risk parameters**: the inventory pricing coefficient, the stress shock and a margin multiplier that scales its margin rates between a quarter and five times the base schedule. BTC and ETH use a quarter, which is what allows 20x; see [Margin](../risk/margin.md#where-these-numbers-come-from).
- **Disable a market.** A disabled market accepts only trades that reduce positions, and keeps settling funding, liquidations and closes.

Every one of these changes is a public on-chain transaction and takes effect immediately on the development deployment. In production these powers are planned to sit behind a timelock, so that changes are visible for days before they apply. An emergency council can disable a market or tighten its limits at once, but cannot loosen them. See [Governance](../protocol/governance.md).

Any change to market policy also invalidates every approval issued under the old policy, so a trade in flight is re-checked against the new rules.

A market is never deleted and its number is never reused. Retiring a market means disabling it and leaving it in place until every position is closed.
