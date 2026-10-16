# Leaderboard and points

The **Leaderboard** page ranks traders by volume or by profit, and shows the points you have earned. Open it from **Leaderboard** in the top bar, or the tab bar on a phone.

## The leaderboard

The board lists the top 50 traders over the last 24 hours, 7 days, 30 days or all time. Rank them by **Volume**, the total size of their trades, or by **PnL**, what they made or lost in that period. The app remembers your choice.

Each row shows the trader's wallet address, volume, PnL, number of trades and points. Your own row is highlighted and marked **You**.

- Trades made on Home and in Pro both count. Home trades sit in a separate account for each market, and the board adds them to the wallet that owns them.
- PnL is realized profit or loss, after fees and funding, from trades in that period that reduced or closed a position. Positions you still hold do not count until you close them.
- The board is worked out from events on the chain, so anyone can check it. It updates within a block of each trade.

## Points

You earn **1 point for every $100 you trade**, whether you open, add to, reduce or close a position. A $50 trade at 5× is a $250 position, so it earns 2 points. Liquidations, funding and closes at the oracle price while trading is paused earn none.

Points are counted per week. A week starts on Thursday at 00:00 UTC, and the page shows how long is left in the current one. Your all-time total is the sum of every week.

Points are a record of your trading. They are not a token, cannot be transferred and have no cash value.

The same numbers are available from the indexer at `GET /v1/leaderboard?window=7d&sort=volume` and `GET /v1/points/{address}`.
