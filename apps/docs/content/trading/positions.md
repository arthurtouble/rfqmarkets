# Positions and your account

You hold at most one position per market: a single net long or short in BTC and a single one in ETH. Trading in the same direction adds to it, trading the other way reduces it, closes it or flips it. Both positions share one pool of USDC collateral.

## The positions table

| Column | Meaning |
| --- | --- |
| **Market** | BTC-PERP or ETH-PERP. |
| **Size** | Long or short, in BTC or ETH. |
| **Entry** | The average price of the position. Adding averages in; reducing leaves it alone; flipping resets it. |
| **Mark** | The price the position is valued at: the oracle bid for a long, the oracle ask for a short. |
| **Notional** | The position's size times the oracle ask. This is the figure margin requirements are based on. |
| **uPnL** | Unrealized profit or loss: size times the difference between mark and entry. |
| **Funding** | Funding accrued since the position was last settled. Negative means you owe it. See [Funding](../risk/funding.md). |
| **Est. liq.** | The estimated mid price at which the account would become liquidatable. See [Liquidation](../risk/liquidation.md). |

The table updates with every price tick, except **Est. liq.**, which updates when your account data refreshes.

## The account card

| Figure | Meaning |
| --- | --- |
| **Equity** | Collateral plus unrealized profit or loss. The line underneath splits out the unrealized PnL and accrued funding. |
| **Collateral** | The USDC credited to your account: deposits, minus withdrawals, plus realized profits, minus realized losses, fees and funding paid. |
| **Available margin** | How much more risk you can open, and the most you can withdraw. It counts your losses but not your unrealized gains. |
| **Margin usage** | Maintenance margin divided by equity. At 100% the account can be liquidated. |
| **Leverage** | The total notional of your positions divided by equity. |
| **Maintenance margin** | The minimum equity you must keep to avoid liquidation. |
| **Liquidation buffer** | Equity minus maintenance margin: how much you can lose before liquidation. |

A **Liquidatable** label appears on the card if equity falls below maintenance margin. [Margin](../risk/margin.md) explains how these figures are calculated, including why unrealized gains count for some purposes and not others.

## Closing a position

Click **Close** on the position's row. The app asks the maker for an exact quote to trade the opposite of your whole position, marked reduce-only, and you sign it in your wallet. Closing never uses the quick-trading key, so it always asks your wallet.

To close part of a position, place an ordinary trade in the opposite direction for the amount you want to take off, with **Reduce only** ticked.

A close pays the normal 2 basis point fee. Any profit or loss on the closed part, and any funding owed, is settled into your collateral at that moment.

### Closing while trading is paused

If trading is paused, the **Close** button becomes **Close at oracle**, and the table shows a note that you can still close at the verified directional oracle price. This close does not need the maker or the approvers. It closes the whole position at the oracle's bid (for a long) or ask (for a short), with no fee, and the venue sponsors the transaction. If the venue's servers are down too, you can do the same from the [exit page](../protocol/safety-and-exits.md).

## History

The tabs under the chart also show:

- **Orders**: your limit orders and their status. See [Limit orders](limit-orders.md).
- **Trades**: every trade your account has executed, with price, fee and a link to the transaction. Each trade shows *included* once it is in a block and *finalized* a couple of blocks later.
- **History**: every on-chain event on your account: deposits, withdrawals, trades, funding settlements, sessions granted and revoked, liquidations.

All of this is read from the public chain, so it is the same record anyone can verify on a block explorer.

## The Markets page

**Markets** in the top bar shows the venue as a whole: total deposited collateral, the number of accounts and open positions, each market's long and short open interest, the funding rate, every open position by wallet address, and the last 30 trades. It reads only finalized chain data.

Positions on RFQ Markets are public in the same way every Base transaction is public. Your account is identified by its wallet address and nothing else.
