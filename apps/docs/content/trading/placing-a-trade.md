# Placing a trade

A market order on RFQ Markets is a request for one firm price for one exact size. It fills completely within the protection you sign, or it does not fill at all. This page covers the ticket, what happens after you click, and what to do when a trade is refused.

## The ticket

| Field | What it does |
| --- | --- |
| **Buy / Long** and **Sell / Short** | The direction. Buying opens or adds to a long, or reduces a short. Selling does the opposite. |
| **Market** and **Limit** | The order type. Market orders fill now. Limit orders wait for your price; see [Limit orders](limit-orders.md). |
| **Size** | The notional value of the trade in USDC, up to six decimals. The app converts it to BTC or ETH at the current mid when it requests the quote. |
| **10%, 25%, 50%, Max** | Shortcuts that size the trade as a share of the most you can currently open: the smaller of the market's maximum trade size and five times your available margin. |
| **Reduce only** | Guarantees the trade can only shrink your existing position. It can never increase it or flip it to the other side. |

Under the size, the ticket shows the **Estimated price**, your **Maximum accepted price** (for a buy) or **Minimum accepted price** (for a sell), the size in BTC or ETH, the **Fee (max)** and, when your wallet is connected, the **Initial margin after** the trade. If the trade needs more margin than you have, the ticket warns you before you submit.

**Price details** opens a breakdown: the oracle side the quote starts from, the maker's current spread in basis points, the inventory adjustment in dollars, how old the price is in milliseconds, and the market's maximum size per trade.

## Price protection

Every market order carries a limit price that you sign. The app sets it 8 basis points beyond the firm quote: above it for a buy, below it for a sell. On a 20 USDC trade that is less than 2 cents of room.

The protection is enforced by the contract. If the price the maker approves is worse than your limit, or the fee is higher than the maximum you signed, the contract rejects the trade. The venue's servers cannot widen your protection after you sign, and they cannot fill you at a worse price.

There is no slippage setting in the app today. 8 basis points is deliberately tight; if the market moves more than that between your click and the trade's inclusion, which is rare in a few seconds, the trade simply fails and you can try again at the new price.

## What happens after you click

1. **Getting a firm quote.** The app asks the venue for a quote for your exact size. The quote is valid for about ten seconds at most, and less if the oracle report it is based on is about to expire.
2. **Confirm in your wallet.** You sign a *TradeIntent*: your account, the market, the exact size in base units, your limit price, the maximum fee, a random one-time nonce and a deadline 30 seconds away. With [quick trading](quick-trading.md) on, the app signs instantly with your session key instead.
3. **Collecting approver signatures.** The venue re-prices your trade against a fresh oracle report. If the new price is still inside your limit, it reserves the maker's capacity for your trade and asks three independent approvers to check and co-sign it. Two signatures are enough.
4. **Settlement.** The venue simulates the transaction, submits it to Base and pays the gas. The contract verifies everything again and settles the trade.

The notice in the corner of the screen follows these steps and ends with the fill price, the block number and a link to the transaction. A trade usually completes a few seconds after you sign.

Only one action runs at a time. Wait for the notice to finish before placing another trade.

## Fees

The trading fee is 2 basis points (0.02%) of the trade's notional, charged in USDC from your collateral when the trade settles. A 25 USDC trade pays half a cent. The maker's spread is separate and is already included in the price. [Pricing and fees](../risk/pricing-and-fees.md) explains both.

There is no gas cost to you for trading. The venue pays it.

## When a trade is refused

A refused trade costs nothing. Nothing is signed into the contract until settlement, and the nonce you signed is only used up if the trade settles. The common reasons are below; the error notice shows the exact message.

| Message | What it means | What to do |
| --- | --- | --- |
| **Waiting for fresh prices** | The app has not had a price update for over 2.5 seconds. | Wait a moment. If it persists, the price stream is down. |
| **Maximum per trade is … USDC** | Your size is above the market's per-trade limit. | Trade a smaller size, or split it. |
| **price moved beyond signed protection** | The fresh price at approval time was worse than your limit. | Try again; the ticket now shows the new price. |
| **quote expired** | Too much time passed between the quote and your signature. | Try again and sign promptly. |
| **Insufficient margin** | The trade would leave your account below its initial margin. | Deposit more, or trade a smaller size. |
| **Only exposure-reducing buys/sells are available** | The maker is at a risk limit or its hedging is unavailable, so only trades that reduce its exposure are accepted. | Trade the other direction, close, or wait. |
| **outstanding approvals exceed gross, net, stress, side or capital capacity** | The maker has no room for more exposure in this direction right now. | Trade a smaller size or wait. |
| **approver quorum unavailable** | Fewer than two approvers answered. | Wait and retry. Your funds are unaffected. |
| **market is paused** | Trading is paused. Closing at the oracle price and withdrawals still work. | See [Safety and exits](../protocol/safety-and-exits.md). |
| **request rate limit exceeded** | You sent too many requests in a short time. | Wait ten seconds. |

A trade that is refused for capacity reasons is not a malfunction. The maker has hard limits on how much risk it can carry, and the venue refuses risk it cannot back rather than accepting it and hoping. [Markets and limits](../markets/markets-and-limits.md) describes those limits.

## Reduce only

Tick **Reduce only** when a trade must not open new risk, for example when you are trimming a position near its limit. A reduce-only trade must make your position strictly smaller and cannot flip its direction. If it would, the contract rejects it. Reductions are also allowed in situations where opening trades are not: on a disabled market, when the maker is over a limit, or when your account is between its initial and maintenance margin.

The **Close** button on a position always sends a reduce-only trade for its exact size.
