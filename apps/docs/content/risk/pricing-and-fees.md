# Pricing and fees

Every price on RFQ Markets is built the same way: start from the oracle, add the maker's spread, and adjust for what your trade does to the maker's inventory. The trading fee is charged on top. This page gives the formula and the current values.

## The price you trade at

For a buy, the price starts from the oracle **ask**. For a sell, from the oracle **bid**. Then:

```
spread charge    = notional × spread (bps) ÷ 10,000
inventory charge = change in the maker's inventory cost caused by this trade
premium          = (spread charge + inventory charge) as a price difference
buy price        = oracle ask + premium
sell price       = oracle bid − premium
```

The fee is separate:

```
fee = notional × 2 bps
```

All three numbers are shown on the ticket: the estimated price includes the spread and inventory charge, **Fee (max)** shows the fee, and **Price details** splits out the spread and the inventory adjustment.

## The spread

The maker's spread is adaptive. It starts from a base and widens when trading is riskier for the maker:

| Component | What widens it | Cap |
| --- | --- | ---: |
| Base | Always present | 2 bps today, 20 bps at most |
| Volatility | Fast price movement across the oracle's sources | 40 bps |
| Flow toxicity | Recent fills that the market then moved against the maker | 35 bps |
| Hedging | The cost and latency of hedging, and whether hedging is degraded | 30 bps |
| Basis | A gap between the hedging venue and the oracle | 25 bps |
| Uncertainty | Disagreement between oracle sources | 20 bps |

The total is capped at 100 bps. In calm markets it is close to the 2 bps base. The current total is shown as **Quote spread** in the market header.

The flow-toxicity component reacts to how the market moves after the maker's fills in aggregate, decaying with a 30-second half-life. It does not look at who you are; the same price applies to every trader at the same moment and size.

## The inventory charge

The maker prices its inventory with a simple convex cost: the larger its net position in a market, the more each additional unit costs. For a market with net trader position *x* (in USDC), the maker's inventory cost is proportional to *x*², with a coefficient set per market by governance.

Your trade's inventory charge is the change in that cost:

- If your trade **adds** to the side traders are already on, the charge is positive and your price is a little worse.
- If your trade **reduces** the imbalance, the charge is negative and your price is a little better than the spread alone would give.

The contract recomputes the minimum inventory charge itself from the actual settled positions, and refuses a trade whose price does not include it. At the development caps the charge is a tiny fraction of a cent.

Trades that are still in flight count too. If another trade in the same direction has been approved but not yet settled, your quote is priced as if it will settle, so that splitting a large trade across several wallets does not make it cheaper.

## The fee

The fee is 2 basis points (0.02%) of notional on every trade, market or limit, open or close. It is deducted from your collateral when the trade settles. The message you sign includes a maximum fee, and the contract refuses any trade that charges more.

Fees are split between the insurance fund and the maker. Until the insurance fund reaches a quarter of the maker's capital target, 20% of each fee goes to insurance; after that, 10%. The rest goes to the maker's capital.

There are no deposit, withdrawal or gas fees. Liquidation has its own penalty, described in [Liquidation](liquidation.md).

## Price protection

On top of the firm price, the app sets your signed limit 8 basis points worse, so that small movements between your click and settlement do not cause a failure. You never pay this 8 bps unless the market actually moves; you pay the price the maker approves, which is at or better than your limit. See [Placing a trade](../trading/placing-a-trade.md#price-protection).

## Example

Buying 20 USDC of BTC when the oracle ask is 100,000, the spread is 2 bps and the maker's inventory is flat:

- spread charge: 20 × 0.0002 = 0.004 USDC, or 2 bps on the price;
- buy price: about 100,020;
- fee: 0.004 USDC;
- signed limit: about 100,100 (8 bps above).

The round-trip cost of opening and closing in calm conditions is therefore roughly the oracle's bid-ask width, plus about 4 bps of spread and 4 bps of fees.
