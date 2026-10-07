# Positions and your account

You hold at most one position per market: a single net long or short in BTC and a single one in ETH. Trading in the same direction adds to it, trading the other way reduces it, closes it or flips it. Both positions share one pool of USDC collateral.

## The positions table

Open positions appear in the **Positions** tab under the chart on the trade page, and on the Portfolio page.

| Column | Meaning |
| --- | --- |
| **Market** | BTC or ETH, with a Long or Short label. |
| **Size** | The position's value in USDC, with its size in BTC or ETH underneath. |
| **Entry** | The average price of the position. Adding averages in; reducing leaves it alone; flipping resets it. |
| **Mark** | The price the position is valued at: the oracle bid for a long, the oracle ask for a short. |
| **Liq. price** | The estimated mid price at which the account would become liquidatable. It turns red when the price is within 10% of it. See [Liquidation](../risk/liquidation.md). |
| **Margin** | The initial margin this position uses. |
| **Funding** | Advanced view only. Funding accrued since the position was last settled. Negative means you owe it. See [Funding](../risk/funding.md). |
| **PnL** | Unrealized profit or loss: size times the difference between mark and entry. The percentage underneath is the return on the position's margin. |

On a phone, each position is a card showing the side, the profit or loss with its return on margin, and the size, entry, mark, margin, liquidation price and funding. The phone's trade page shows only the position in the market you are looking at; the Portfolio tab shows all of them. When the price gets within 10% of a position's liquidation price, its card says so.

The figures update with every price tick, except the liquidation price, which updates when your account data refreshes.

## Your account

The **Account value** card on the trade page summarises the account as a whole, and the top of the Portfolio page adds the margin figures:

| Figure | Meaning |
| --- | --- |
| **Account value** | Your equity: collateral plus unrealized profit or loss. The line underneath shows the unrealized PnL. |
| **Cash balance** | Your collateral: deposits, minus withdrawals, plus realized profits, minus realized losses, fees and funding paid. |
| **Available to trade** | How much more margin you can commit, and the most you can withdraw. It counts your losses but not your unrealized gains. |
| **Margin in use** | The initial margin your open positions need. |
| **Leverage** | The total value of your positions divided by your account value. |
| **Maintenance margin** | The account value you must keep to avoid liquidation. |

[Margin](../risk/margin.md) explains how these figures are calculated, including why unrealized gains count for some purposes and not others.

## Closing a position

Click **Close** on the position. A sheet opens titled, for example, **Close BTC long**, with a choice of how much to close: **25%**, **50%**, **75%** or **100%**. It shows the size being closed, the estimated price and the estimated profit or loss. Click **Close BTC long** (or **Close 50% of BTC long**) to request an exact quote for that amount, and sign it.

A close is a reduce-only trade, so it can never accidentally open a position the other way. If [one-click trading](one-click-trading.md) is on and covers the close, it signs without a wallet prompt; otherwise your wallet asks.

A close pays the normal 2 basis point fee. Any profit or loss on the closed part, and any funding owed, is settled into your collateral at that moment.

Closes are not limited by the per-trade cap. You can close a position in one go even if it was built up from many capped trades.

### Closing every position

With two or more positions open, **Close all** sits above the positions (in the table's header on desktop). Its sheet lists each position with its profit or loss and the estimated total. **Close N positions** gets a separate exact quote for each position and closes them one after another; with one-click trading on, they close without wallet prompts. If one close fails, the others still go through and the message names the position still open.

### Closing while trading is paused

If trading is paused, the position shows a note, "Trading is paused. You can still close the whole position at the oracle price.", and the button becomes **Close BTC at oracle price**. This close does not need the maker or the approvers. It closes the whole position at the oracle's bid (for a long) or ask (for a short), with no fee, and the venue sponsors the transaction. **Close all** does the same for each position in turn, with one wallet prompt each. If the venue's servers are down too, you can do the same from the [exit page](../protocol/safety-and-exits.md).

## Portfolio and history

The Portfolio page's **PnL** card charts your profit or loss over the last 24 hours, week, month or all time: realized PnL after fees and funding, plus your open positions at live prices. Underneath are your realized PnL, fees paid, funding, trading volume, net deposits and number of trades.

The tabs under the chart on the trade page, and at the bottom of the Portfolio page, list your history, newest first. Each time links to the transaction on the block explorer.

- **Orders**: your limit and trigger orders. See [Limit orders](limit-orders.md).
- **Trades**: every fill, described by what it did (Open long, Add to long, Reduce long, Close long, Flip to short, Liquidated), with size, price, fee and the profit or loss it realized. **Show more** loads older trades.
- **Funding** (Portfolio): each funding payment you paid or received, with the running total.
- **Transfers** (Portfolio): deposits, withdrawals, one-click trading turned on and off, liquidations and cancelled orders.

All of this is read from the public chain, so it is the same record anyone can verify on a block explorer.

## The Markets page

**Markets** shows the venue as a whole. Search by name or symbol, then pick a market to trade it. For each market it lists the maximum leverage, a 24-hour price line, the price, its change over the last 24 hours and the funding rate; Advanced view adds the 24-hour high and low. A market whose price is late shows **Price delayed**, one governance has paused shows **Paused**, and one the oracle does not price yet shows **No price**. Below that are the open interest in each market split between longs and shorts, the total deposited, the number of traders and open positions, and the most recent trades. Advanced view adds every open position by wallet address, the fee and wallet on each trade, and how far the indexer has read the chain. It reads only finalized chain data.

Positions on RFQ Markets are public in the same way every Base transaction is public. Your account is identified by its wallet address and nothing else.
