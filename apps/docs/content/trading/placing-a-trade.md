# Placing a trade

A market order on RFQ Markets is a request for one firm price for one exact size. It fills completely within the protection you sign, or it does not fill at all. This page covers the ticket, what happens after you click, and what to do when a trade is refused.

## The ticket

The ticket sits on the right of the trade page on a computer. On a phone, tap **Long** or **Short** at the bottom of the screen and it opens as a sheet.

| Control | What it does |
| --- | --- |
| **Long** and **Short** | The direction. Long opens or adds to a long, or reduces a short. Short does the opposite. |
| **Market** and **Limit** | The order type, shown in Advanced view only. Market orders fill now. Limit orders wait for your price; see [Limit orders](limit-orders.md). In Simple view every order is a market order. |
| **Amount** | The size of the position in USDC, up to six decimals. This is the notional value, not the margin you put up: a 20 USDC long opens 20 USDC of exposure. The app converts it to BTC or ETH at the current price, and shows the result as "≈ 0.0002 BTC" under the field. |
| **25%, 50%, 75%, Max** | Shortcuts that size the trade as a share of the most you can open: the market's per-trade cap, or your **Available** margin at 5x, whichever is smaller. |
| **Reduce only** | Advanced view only. Guarantees the trade can only shrink your existing position. It can never increase it or flip it to the other side. |

Under the amount, the ticket shows the **Entry price** you can expect, the **Fee** and your **Leverage after** the trade. Advanced view adds the **Price protection** (the worst price you will sign), the maker's current **Spread** in basis points, the **Inventory adjustment** for your size and the market's **Max per trade**. If the trade needs more margin than you have, a warning appears above the button.

> **Note.** The Max shortcut still sizes for 5x, so it can suggest less than you could actually open at 20x. You can type a larger amount yourself; the ticket checks it against your real margin.

The button says what will happen, for example **Long BTC · $20.00**. When something is missing, it says that instead: **Enter an amount**, **Up to $25.00 per trade**, **Add funds for this size** and so on.

## Reviewing a market order

Unless one-click trading is on, every market order opens a **Review order** sheet before your wallet does. It restates the trade in a sentence ("Long 0.0002 BTC on Bitcoin for $20.00. It fills at this price or better, or not at all."), then lists the entry price, price protection, fee and position size.

If you do not have a one-click session, the sheet also offers to turn on [one-click trading](one-click-trading.md) at the same time, with the box ticked by default. Leave it ticked if you trade often: it costs one extra signature now and skips this review and the wallet prompt for the next eight hours. Untick it if you would rather confirm every trade in your wallet.

Click **Confirm and sign** to continue. When one-click trading is on and covers the trade, there is no review: the ticket shows "One-click trading is on. No wallet prompt." and the order goes straight through.

## Price protection

Every market order carries a limit price that you sign. The app sets it 8 basis points beyond the firm quote: above it for a long, below it for a short. On a 20 USDC trade that is less than 2 cents of room.

The protection is enforced by the contract. If the price the maker approves is worse than your limit, or the fee is higher than the maximum you signed, the contract rejects the trade. The venue's servers cannot widen your protection after you sign, and they cannot fill you at a worse price.

The app does not let you change the 8 basis points. It is deliberately tight; if the market moves more than that between your click and the trade's inclusion, which is rare in a few seconds, the trade simply fails and you can try again at the new price. Integrators can choose their own protection, from 1 to 500 basis points, with `slippageBps` on the [quote endpoint](../integrate/api.md#trading).

## What happens after you click

1. **Getting a firm quote.** The app asks the venue for a quote for your exact size. The quote is valid for about ten seconds at most, and less if the oracle report it is based on is about to expire.
2. **Confirm in your wallet.** You sign a *TradeIntent*: your account, the market, the exact size in base units, your limit price, the maximum fee, a random one-time nonce and a deadline 30 seconds away. With [one-click trading](one-click-trading.md) on, the app signs instantly with your session key instead.
3. **Collecting approver signatures.** The venue re-prices your trade against a fresh oracle report. If the new price is still inside your limit, it reserves the maker's capacity for your trade and asks three independent approvers to check and co-sign it. Two signatures are enough.
4. **Settlement.** The venue simulates the transaction, submits it to Base and pays the gas. The contract verifies everything again and settles the trade.

The notice at the edge of the screen follows these steps and ends with the fill price, the block number and a link to the transaction. A trade usually completes a few seconds after you sign.

Only one action runs at a time. Wait for the notice to finish before placing another trade.

## Fees

The trading fee is 2 basis points (0.02%) of the trade's notional, charged in USDC from your collateral when the trade settles. A 25 USDC trade pays half a cent. The maker's spread is separate and is already included in the price. [Pricing and fees](../risk/pricing-and-fees.md) explains both.

There is no gas cost to you for trading. The venue pays it.

## When a trade is refused

A refused trade costs nothing. Nothing is signed into the contract until settlement, and the nonce you signed is only used up if the trade settles. The common reasons are below; the error notice shows the exact message.

| Message | What it means | What to do |
| --- | --- | --- |
| **Waiting for a fresh price** | The app has not had a price update for over 2.5 seconds. | Wait a moment. If it persists, the price stream is down. |
| **Up to … per trade** | Your amount is above the market's per-trade limit. | Trade a smaller amount, or split it. |
| **Long is closed right now** (or Short) | The maker is only accepting trades in the other direction in this market. | Trade the other direction, close, or wait. |
| **price moved beyond signed protection** | The fresh price at approval time was worse than your limit. | Try again; the ticket now shows the new price. |
| **quote expired** | Too much time passed between the quote and your signature. | Try again and sign promptly. |
| **Add funds for this size** | The trade would leave your account below its initial margin. | Deposit more, or trade a smaller amount. |
| **Only exposure-reducing buys/sells are available** | The maker is at a risk limit or its hedging is unavailable, so only trades that reduce its exposure are accepted. | Trade the other direction, close, or wait. |
| **outstanding approvals exceed gross, net, stress, side or capital capacity** | The maker has no room for more exposure in this direction right now. | Trade a smaller size or wait. |
| **approver quorum unavailable** | Fewer than two approvers answered. | Wait and retry. Your funds are unaffected. |
| **Trading paused** | Trading is paused. Closing at the oracle price and withdrawals still work. | See [Safety and exits](../protocol/safety-and-exits.md). |
| **request rate limit exceeded** | You sent too many requests in a short time. | Wait ten seconds. |

A trade that is refused for capacity reasons is not a malfunction. The maker has hard limits on how much risk it can carry, and the venue refuses risk it cannot back rather than accepting it and hoping. [Markets and limits](../markets/markets-and-limits.md) describes those limits.

## Reduce only

In Advanced view, tick **Reduce only** when a trade must not open new risk, for example when you are trimming a position near its limit. A reduce-only trade must make your position strictly smaller and cannot flip its direction. If it would, the contract rejects it. Reductions are also allowed in situations where opening trades are not: on a disabled market, when the maker is over a limit, or when your account is between its initial and maintenance margin.

Closing a position from its **Close** button always sends a reduce-only trade, so you do not need to tick the box for that. See [Positions](positions.md#closing-a-position).
