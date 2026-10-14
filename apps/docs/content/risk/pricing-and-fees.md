# Pricing and fees

Every price on RFQ Markets is built the same way: start from the oracle, add the maker's spread, and adjust for what your trade does to the maker's inventory. There is no trading fee: the platform's charge is a 2 bps markup inside the spread, so the price you see is all you pay. This page gives the formula and the current values.

## The price you trade at

For a buy, the price starts from the oracle **ask**. For a sell, from the oracle **bid**. Then:

```
spread charge    = notional × spread (bps) ÷ 10,000
inventory charge = change in the maker's inventory cost caused by this trade
premium          = (spread charge + inventory charge) as a price difference
buy price        = oracle ask + premium
sell price       = oracle bid − premium
```

The ticket shows the estimated price, which includes everything you pay, and **Fee** reads **None**. **Price details** splits out the spread and the inventory adjustment.

## The spread

The maker's spread is adaptive. It starts from a base and widens when trading is riskier for the maker:

| Component | What widens it | Cap |
| --- | --- | ---: |
| Base | Always present: the market's base spread plus the 2 bps platform markup | 4 bps today, 52 bps at most |
| Volatility | Fast price movement across the oracle's sources | 40 bps |
| Flow toxicity | Recent fills that the market then moved against the maker | 35 bps |
| Hedging | The cost and latency of hedging, and whether hedging is degraded | 30 bps |
| Basis | A gap between the hedging venue and the oracle | 25 bps |
| Uncertainty | Disagreement between oracle sources | 20 bps |

The total is capped at 100 bps. In calm markets it is close to the 4 bps base. The current total is shown as **Quote spread** in the market header.

The flow-toxicity component reacts to how the market moves after the maker's fills in aggregate, decaying with a 30-second half-life. It does not look at who you are; the same price applies to every trader at the same moment and size.

## The inventory charge

The maker prices its inventory with a simple convex cost: the larger its net position in a market, the more each additional unit costs. For a market with net trader position *x* (in USDC), the maker's inventory cost is proportional to *x*², with a coefficient set per market by governance.

Your trade's inventory charge is the change in that cost:

- If your trade **adds** to the side traders are already on, the charge is positive and your price is a little worse.
- If your trade **reduces** the imbalance, the charge is negative and your price is a little better than the spread alone would give.

The contract recomputes the minimum inventory charge itself from the actual settled positions, and refuses a trade whose price does not include it. At the development caps the charge is a tiny fraction of a cent.

Trades that are still in flight count too. If another trade in the same direction has been approved but not yet settled, your quote is priced as if it will settle, so that splitting a large trade across several wallets does not make it cheaper.

## No fees

There is no trading fee on any trade, market or limit, open or close. The platform earns a 2 basis point (0.02%) markup that is part of the spread's base component, so it is already in the price you see. The message you sign still includes a maximum fee, which is zero, and the contract refuses any trade that charges one.

Approvers enforce the markup: they refuse a fill whose price is not at least the market's base spread plus 2 bps (plus the inventory charge) away from the oracle.

The contract can still charge an on-chain fee, which it splits between the insurance fund and the maker. With the fee at zero, the insurance fund grows from liquidation penalties and from direct top-ups by the operator.

There are no deposit, withdrawal or gas fees. Liquidation has its own penalty, described in [Liquidation](liquidation.md).

## Price protection

On top of the firm price, the app sets your signed limit 8 basis points worse, so that small movements between your click and settlement do not cause a failure. You never pay this 8 bps unless the market actually moves; you pay the price the maker approves, which is at or better than your limit. Through the API you can choose a different band, from 1 to 500 bps; [stop orders](../trading/stop-orders.md) default to 100 bps because they fire in moving markets. See [Placing a trade](../trading/placing-a-trade.md#price-protection).

## Example

Opening a 20 USDC long on BTC when the oracle ask is 100,000, the spread is 4 bps and the maker's inventory is flat:

- spread charge: 20 × 0.0004 = 0.008 USDC, or 4 bps on the price (2 bps base spread and the 2 bps markup);
- buy price: about 100,040;
- fee: none;
- signed limit: about 100,120 (8 bps above).

The round-trip cost of opening and closing in calm conditions is therefore roughly the oracle's bid-ask width plus about 8 bps of spread, with no fees.
