# Pricing and fees

Every trade on RFQ Markets pays two things: a **price**, built from the oracle mid plus the maker's spread and the effect your trade has on the maker's inventory, and a **trading fee** of 0.04% of the notional. In a calm market a small trade carries a spread of a fraction of a basis point, so it fills within a few dollars of the oracle price on BTC and pays the fee. This page gives the formula and the current values.

## The price you trade at

The price starts from the oracle **mid**, halfway between the oracle bid and ask. Then:

```
spread charge    = notional × spread (bps, in steps of 0.1) ÷ 10,000
inventory charge = change in the maker's inventory cost caused by this trade
premium          = (spread charge + inventory charge) as a price difference
buy price        = mid + premium
sell price       = mid − premium
```

The contract checks the inventory charge against the same mid, so the price does not depend on how far apart the exchanges the oracle reads are. That gap is the oracle's bid and ask; it still sets how open positions are valued (see [Margin](margin.md)), but not what a trade pays.

The app shows the estimated price and, on its own line, the fee. In Pro, the market details show the bid and ask a small trade fills at right now, the gap between them as **Spread**, and the **Trading fee**.

## The spread

The maker's spread is adaptive. It has no fixed part: it widens only when trading is riskier for the maker.

| Component | What widens it | Cap |
| --- | --- | ---: |
| Volatility | Fast price movement across the oracle's sources (a fifth of the short-horizon risk, to the nearest 0.1 bps) | 40 bps |
| Flow toxicity | Recent fills that the market then moved against the maker | 35 bps |
| Hedging | The cost and latency of hedging, and whether hedging is degraded | 30 bps |
| Basis | A gap between the hedging venue and the oracle | 25 bps |
| Uncertainty | Disagreement between oracle sources | 20 bps |

Every component moves in steps of 0.1 bps (about $1 on a $100,000 BTC price), so the price follows the market smoothly instead of jumping a whole basis point at a time. The total is capped at 100 bps. In calm markets it is a few tenths of a basis point. On top of it, larger trades pay more through the inventory charge below, much as a larger order walks further into an order book.

The flow-toxicity component reacts to how the market moves after the maker's fills in aggregate, decaying with a 30-second half-life. It does not look at who you are; the same price applies to every trader at the same moment and size.

## The inventory charge

The maker prices its inventory with a simple convex cost: the larger its net position in a market, the more each additional unit costs. For a market with net trader position *x* (in USDC), the maker's inventory cost is proportional to *x*², with a coefficient set per market by governance.

Your trade's inventory charge comes from the change in that cost:

- If your trade **adds** to the side traders are already on, you pay the change, and your price is worse the larger the trade. The charge grows with volatility: it is the plain change in a still market and rises by the same amount again for every 50 bps of short-horizon risk, up to four times. Holding inventory is riskier when prices move fast, so size costs more then.
- If your trade **reduces** the imbalance, you get half of the improvement back as a better price, up to 5 bps of your notional. Your price can then be better than the mid. The maker keeps the other half, so trading in and straight back out always costs more than it earns.

For example, with the maker holding traders' $40,000 net long on BTC, a further $20,000 buy pays $10 (5 bps) in a still market and $30 when the market is moving 100 bps over the short horizon, while a $20,000 sell earns a $3 rebate.

The contract recomputes the minimum inventory charge itself from the actual settled positions, and refuses a trade whose price does not include it (for a reducing trade, a rebate larger than the full improvement). At the development caps the charge is a tiny fraction of a cent.

Trades that are still in flight count too. If another trade in the same direction has been approved but not yet settled, your quote is priced as if it will settle, so that splitting a large trade across several wallets does not make it cheaper.

## The trading fee

Every fill pays a fee in USDC, taken from your balance when the trade settles: **0.04% (4 bps) of the notional** on every market today, for market, limit and stop orders, opening or closing. It is the market's base spread (2 bps by default, set per market by the risk operator between 2 and 50 bps) plus the platform's 2 bps. There are no volume fee tiers.

The message you sign includes a maximum fee, and the contract refuses any trade that charges more. A market order signs the quoted fee, with room for a better fill price on a sell. Limit and stop orders sign a ceiling of 10 bps of the notional at their protected price, and pay the market's fee when they fill. The [trading key](../trading/connecting-to-trade.md) may pay at most 10 bps of its 5,000,000 USDC per-trade limit in fees on any one trade.

Approvers enforce the fee: they refuse a fill whose fee and price premium together are less than the market's fee plus the inventory charge (less the rebate, for a reducing trade).

Part of every fee goes to the insurance fund: 20% while the fund is below a quarter of the maker's capital target, 10% after that. On every fill the contract also moves the same share of the platform's 2 bps from the maker's capital to insurance. Liquidation penalties, after the liquidator's reward, also go to the fund.

The venue charges no deposit or withdrawal fees, and it pays the gas for trades and withdrawals. A deposit is an ordinary transaction from your wallet, so it costs a little ETH for gas. Liquidation has its own penalty, described in [Liquidation](liquidation.md).

## Price protection

On top of the firm price, the app sets your signed limit 8 basis points worse, so that small movements between your click and settlement do not cause a failure. You never pay this 8 bps unless the market actually moves; you pay the price the maker approves, which is at or better than your limit. Through the API you can choose a different band, from 1 to 500 bps; [stop orders](../trading/stop-orders.md) default to 100 bps because they fire in moving markets. See [Placing a trade](../trading/placing-a-trade.md#price-protection).

## Example

Opening a 20 USDC long on BTC when the oracle bid and ask are both 100,000, the market is calm (1 bp of short-horizon risk) and the maker's inventory is flat:

- spread: 0.2 bps, so the buy price is about 100,002 (the inventory charge on 20 USDC is a few millionths of a dollar), which costs 20 × 0.00002 = 0.0004 USDC;
- fee: 20 × 0.0004 = 0.008 USDC;
- signed limit: about 100,080 (8 bps above).

If the exchanges disagree and the oracle shows 99,980 / 100,020, the same trade still fills at about 100,002, just above the mid, and pays the same 0.008 USDC fee.

The round-trip cost of opening and closing in calm conditions is therefore about 8 bps in fees (4 bps each way), plus a fraction of a basis point of spread.
