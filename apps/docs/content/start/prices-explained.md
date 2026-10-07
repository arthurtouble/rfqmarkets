# Prices explained

The trade screen shows several prices at once, and they mean different things. This page explains each one and where it comes from. If you only remember one thing: the big number at the top is a reference, the **Estimated price** on the ticket is what you will probably pay, and the **Maximum** or **Minimum accepted price** is the worst you can pay.

## Oracle bid, ask and mid

The venue runs its own price oracle: three independent nodes that each watch seven exchanges and sign a price every second. Their combined report gives a **bid** and an **ask** for each market, and the **mid** halfway between them. These are the prices in the ticker strip, the large price at the top of the trade page, the chart, and the **Bid** and **Ask** figures in the market header.

The oracle's bid and ask are not anyone's resting orders. They describe where the market is trading across those exchanges, and how much those exchanges disagree with each other. [Price oracle](../markets/price-oracle.md) explains how they are built.

## Estimated price

The **Estimated price** on the ticket is an indicative quote for the exact size you have typed. Your browser computes it on every price update from the oracle price and the maker's published pricing parameters:

- a buy starts from the oracle **ask**, a sell from the oracle **bid**;
- the maker's **spread** is added on top;
- an **inventory adjustment** is added if your trade increases the maker's existing exposure, or subtracted if it reduces it.

The trading fee is shown separately, not folded into this price. Typing a size does not send anything to the venue or reserve anything. You can open **Price details** under the estimate to see the oracle side, the spread, the inventory adjustment and how old the price is. [Pricing and fees](../risk/pricing-and-fees.md) gives the formula.

## Firm quote

When you click Buy or Sell, the app asks the venue for a firm quote at that moment for that exact size. The firm quote is what the approvers check and what the contract executes. It normally matches the estimate closely, but it is computed fresh, so it can differ by a few basis points if the market moved between your last screen update and your click.

## Maximum or minimum accepted price

This is your price protection. The app sets it 8 basis points (0.08%) worse than the firm quote, and it goes into the message you sign as your limit price. The contract refuses to execute your trade at any price worse than this. If the market moves further than that before your trade is included, the trade fails and nothing happens; you are never filled at a worse price than you signed.

## Mark

In the **Positions** table, **Mark** is the price your open position is valued at. It is deliberately conservative: a long is marked at the oracle **bid** and a short at the oracle **ask**, because those are the prices you would roughly receive if you closed. Your unrealized profit or loss and your margin are calculated from this mark. There is no separate, smoothed mark price.

## Entry

**Entry** is the average price of your position. Adding to a position averages the new fill into it. Reducing a position leaves the entry unchanged. If a trade flips you from long to short, or the other way, the entry resets to that trade's price.

## Estimated liquidation price

**Est. liq.** is the mid price at which your account would fall below its maintenance margin, assuming the other market and your collateral stay where they are. It is an estimate refreshed with your account data, not continuously. Because liquidation actually uses the bid for longs and the ask for shorts, the real trigger can come slightly before the mid reaches this number. See [Liquidation](../risk/liquidation.md).

## Limit order prices

On a limit order, the ticket shows **Current ask** (for a buy) or **Current bid** (for a sell). Despite the label, this is the indicative executable price for your size, spread included, not the raw oracle side. Your limit order fills when this executable price reaches your limit, so it is the right number to compare against. **Trigger** tells you how far away that is. See [Limit orders](../trading/limit-orders.md).

## Funding APR

**Funding APR** in the market header is the annualized rate that positions on the crowded side currently pay to the other side. It changes with the balance of long and short positions. See [Funding](../risk/funding.md).
