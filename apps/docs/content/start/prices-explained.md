# Prices explained

The trade screen shows several prices at once, and they mean different things. This page explains each one and where it comes from. If you only remember one thing: the big number at the top is a reference, the **Entry price** on the ticket is what you will probably pay, and the **Price protection** is the worst you can pay.

## Oracle bid, ask and mid

The venue runs its own price oracle: three independent nodes that each watch seven exchanges and sign a price every second. Their combined report gives a **bid** and an **ask** for each market, and the **mid** halfway between them. The mid is the large price at the top of the trade page, the price in the market list and the line on the chart. In Advanced view, the market details also show the **Bid** and **Ask**.

The oracle's bid and ask are not anyone's resting orders. They describe where the market is trading across those exchanges, and how much those exchanges disagree with each other. [Price oracle](../markets/price-oracle.md) explains how they are built.

The chart plots the mid across the most recent price updates, with the high and low of that window. The change shown beside the price is the change across the same window, not over a day.

## Entry price

The **Entry price** on the ticket is an indicative quote for the exact amount you have typed. Your browser computes it on every price update from the oracle price and the maker's published pricing parameters:

- a long starts from the oracle **ask**, a short from the oracle **bid**;
- the maker's **spread** is added on top;
- an **inventory adjustment** is added if your trade increases the maker's existing exposure, or subtracted if it reduces it.

The trading fee is shown separately, not folded into this price. Typing an amount does not send anything to the venue or reserve anything. Advanced view shows the spread and inventory adjustment as separate rows. [Pricing and fees](../risk/pricing-and-fees.md) gives the formula.

## Firm quote

When you place the order, the app asks the venue for a firm quote at that moment for that exact size. The firm quote is what the review sheet shows, what the approvers check and what the contract executes. It normally matches the estimate closely, but it is computed fresh, so it can differ by a few basis points if the market moved between your last screen update and your click.

## Price protection

This is the worst price you accept: a maximum for a long, a minimum for a short. By default the app sets it 8 basis points (0.08%) worse than the firm quote (you can change this under **Options** in Advanced view), and it goes into the message you sign as your limit price. The contract refuses to execute your trade at any price worse than this. If the market moves further than that before your trade is included, the trade fails and nothing happens; you are never filled at a worse price than you signed. The review sheet always shows it; the ticket shows it in Advanced view.

## Mark

**Mark** in the positions table is the price your open position is valued at. It is deliberately conservative: a long is marked at the oracle **bid** and a short at the oracle **ask**, because those are the prices you would roughly receive if you closed. Your unrealized profit or loss and your margin are calculated from this mark. There is no separate, smoothed mark price.

## Entry

**Entry** in the positions table is the average price of your position. Adding to a position averages the new fill into it. Reducing a position leaves the entry unchanged. If a trade flips you from long to short, or the other way, the entry resets to that trade's price.

## Liquidation price

**Liq. price** is the mid price at which your account would fall below its maintenance margin, assuming your other positions and your collateral stay where they are. It is an estimate refreshed with your account data, not continuously. Because liquidation actually uses the bid for longs and the ask for shorts, the real trigger can come slightly before the mid reaches this number. See [Liquidation](../risk/liquidation.md).

## Limit order prices

On a limit order, the ticket shows **Current price** in place of Entry price. It is the indicative executable price for your size, spread included, not the raw oracle side. Your limit order fills when this executable price reaches your limit, so it is the right number to compare against. The hint under the limit price tells you whether the order would fill now. See [Limit orders](../trading/limit-orders.md).

## Trigger prices

[Stop orders](../trading/stop-orders.md) are different again: they trigger on the oracle **mid**, not on the executable price, and then fill like a market order within the band you signed.

## Funding

**Funding (yearly)** in the market details is the annualized rate that positions on the crowded side currently pay to the other side. It changes with the balance of long and short positions. See [Funding](../risk/funding.md).
