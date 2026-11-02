# Pricing and fees

Every trade on RFQ Markets pays two things: a **price**, built from the oracle mid plus the maker's spread and the effect your trade has on the maker's inventory, and a **trading fee** of 0.04% of the notional. In a calm market a small trade carries no spread at all, so it fills at the oracle price and pays only the fee. This page gives the formula and the current values.

## The price you trade at

The price starts from the oracle **mid**, halfway between the oracle bid and ask. Then:

```
spread charge    = notional × spread (bps) ÷ 10,000
inventory charge = change in the maker's inventory cost caused by this trade
premium          = (spread charge + inventory charge) as a price difference
buy price        = the higher of  mid + premium  and  oracle ask + inventory charge
sell price       = the lower of   mid − premium  and  oracle bid − inventory charge
```

The contract never lets a buy fill below the oracle ask or a sell above the oracle bid. The oracle's bid and ask are as far apart as the exchanges it reads disagree, usually a few basis points, so when the spread is smaller than that gap the oracle side sets the price.

The app shows the estimated price and, on its own line, the fee. In Pro, the market details show the bid and ask a small trade fills at right now, the gap between them as **Spread**, and the **Trading fee**.

## The spread

The maker's spread is adaptive. It has no fixed part: it widens only when trading is riskier for the maker.

| Component | What widens it | Cap |
| --- | --- | ---: |
| Volatility | Fast price movement across the oracle's sources (to the nearest bps, so a calm market adds nothing) | 40 bps |
| Flow toxicity | Recent fills that the market then moved against the maker | 35 bps |
| Hedging | The cost and latency of hedging, and whether hedging is degraded | 30 bps |
| Basis | A gap between the hedging venue and the oracle | 25 bps |
| Uncertainty | Disagreement between oracle sources | 20 bps |

The total is capped at 100 bps. In calm markets it is zero or one basis point. On top of it, larger trades pay more through the inventory charge below, much as a larger order walks further into an order book.

The flow-toxicity component reacts to how the market moves after the maker's fills in aggregate, decaying with a 30-second half-life. It does not look at who you are; the same price applies to every trader at the same moment and size.

## The inventory charge

The maker prices its inventory with a simple convex cost: the larger its net position in a market, the more each additional unit costs. For a market with net trader position *x* (in USDC), the maker's inventory cost is proportional to *x*², with a coefficient set per market by governance.

Your trade's inventory charge is the change in that cost:

- If your trade **adds** to the side traders are already on, the charge is positive and your price is a little worse.
- If your trade **reduces** the imbalance, the charge is negative and your price is a little better than the spread alone would give.

The contract recomputes the minimum inventory charge itself from the actual settled positions, and refuses a trade whose price does not include it. At the development caps the charge is a tiny fraction of a cent.

Trades that are still in flight count too. If another trade in the same direction has been approved but not yet settled, your quote is priced as if it will settle, so that splitting a large trade across several wallets does not make it cheaper.

## The trading fee

Every fill pays a fee in USDC, taken from your balance when the trade settles: **0.04% (4 bps) of the notional** on every market today, for market, limit and stop orders, opening or closing. It is the market's base spread (2 bps by default, set per market by the risk operator between 2 and 50 bps) plus the platform's 2 bps. There are no volume fee tiers.

The message you sign includes a maximum fee, and the contract refuses any trade that charges more. A market order signs the quoted fee, with room for a better fill price on a sell. Limit and stop orders sign a ceiling of 10 bps of the notional at their protected price, and pay the market's fee when they fill. A one-tap key may pay at most 10 bps of its per-trade limit in fees on any one trade.

Approvers enforce the fee: they refuse a fill whose fee and price premium together are less than the market's fee (plus the inventory charge).

Part of every fee goes to the insurance fund: 20% while the fund is below a quarter of the maker's capital target, 10% after that. On every fill the contract also moves the same share of the platform's 2 bps from the maker's capital to insurance. Liquidation penalties, after the liquidator's reward, also go to the fund.

The venue charges no deposit or withdrawal fees, and it pays the gas for trades and withdrawals. A deposit is an ordinary transaction from your wallet, so it costs a little ETH for gas. Liquidation has its own penalty, described in [Liquidation](liquidation.md).

## Price protection

On top of the firm price, the app sets your signed limit 8 basis points worse, so that small movements between your click and settlement do not cause a failure. You never pay this 8 bps unless the market actually moves; you pay the price the maker approves, which is at or better than your limit. Through the API you can choose a different band, from 1 to 500 bps; [stop orders](../trading/stop-orders.md) default to 100 bps because they fire in moving markets. See [Placing a trade](../trading/placing-a-trade.md#price-protection).

## Example

Opening a 20 USDC long on BTC when the oracle bid and ask are both 100,000, the market is calm and the maker's inventory is flat:

- spread: 0 bps, so the buy price is the mid, 100,000 (the inventory charge on 20 USDC is a few millionths of a dollar);
- fee: 20 × 0.0004 = 0.008 USDC;
- signed limit: about 100,080 (8 bps above).

If the exchanges disagree and the oracle ask is 100,020, the same trade fills at about 100,020 and pays the same 0.008 USDC fee.

The round-trip cost of opening and closing in calm conditions is therefore the oracle's bid-ask width plus 8 bps in fees (4 bps each way).
