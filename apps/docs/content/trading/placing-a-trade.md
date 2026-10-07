# Placing a trade

A market order on RFQ Markets is a request for one firm price for one exact size. It fills completely within the protection you sign, or it does not fill at all. This page covers the ticket, what happens after you click, and what to do when a trade is refused.

## The ticket

The ticket sits on the right of the trade page on a computer. On a phone, tap **Long** or **Short** at the bottom of the screen and it opens as a sheet; it closes again after a fill so you can see the position.

| Control | What it does |
| --- | --- |
| **Long** and **Short** | The direction. Long opens or adds to a long, or reduces a short. Short does the opposite. |
| **Market**, **Limit** and **Stop** | The order type, shown in Advanced view only. Market orders fill now. Limit orders wait for your price; see [Limit orders](limit-orders.md). Stop orders wait for the price to break a level, then trade; see [Stop loss and take profit](stop-orders.md). In Simple view every order is a market order. |
| **You pay** | The margin you put up, in USDC. The position is this amount times your leverage. |
| **25%, 50%, 75%, Max** | Shortcuts that fill in a share of the most you can pay at the chosen leverage. Max leaves room for the fee and stays within your **Available** margin, the market's per-trade limit and the margin tier for that leverage. |
| **Leverage** | Presets up to the market's maximum (20× on BTC and ETH). Beside it the ticket shows the position you will open, for example "Position $1,250 · 0.0125 BTC". |
| **Options** | Advanced view only. **Reduce only** and **Max slippage**; the row shows what is set, such as "Slippage 0.5% · Reduce only". |

The ticket remembers what you paid and the leverage you picked for each market, and your slippage setting, on this device.

Under the controls the ticket shows the **Entry price** you can expect (the **Current price** for a limit order), your estimated **Liquidation price** after the trade and the **Fee**. Advanced view adds the **Price protection**, the worst price you will sign.

Larger positions need more margin per dollar, so leverage falls in tiers as size grows: on BTC and ETH, 20× is available up to a $25,000 position, 16× up to $100,000, and less beyond. [Margin](../risk/margin.md#rates) has the full table. If you pick more leverage than your size allows, the button says how much you can use, for example **Up to 16× at this size**.

The button says what will happen, for example **Long BTC · $250 at 5×**. When something is missing, it says that instead: **Enter an amount**, **Over the per-trade limit**, **Add funds** and so on. Over the limit, the line under the amount says how much fits, for example "Up to $5.00 at 5× per trade".

## Reviewing a market order

Unless one-click trading is on, every market order opens a **Review order** sheet before your wallet does. The sheet fetches a firm price for your exact size and restates the trade in a sentence ("Long 0.0025 BTC on Bitcoin at 5×, paying $50. It fills at the price protection or better, or not at all."), then lists the entry price, price protection, estimated liquidation price, fee, margin and position size.

The firm price is held for about 30 seconds, and a countdown under the button shows how long is left. When it runs out, the button changes to **Refresh quote**; you can only sign a price that is still held. Nothing is traded until you confirm.

If you do not have a one-click session, the sheet also offers to turn on [one-click trading](one-click-trading.md) at the same time, with the box ticked by default. Leave it ticked if you trade often: it costs one extra signature now and skips this review and the wallet prompt for the next eight hours, for trades up to $2,500. Untick it if you would rather confirm every trade in your wallet.

Click **Confirm and sign** to continue. When one-click trading is on and covers the trade, there is no review: the ticket shows "One-click trading is on. No wallet prompt." and the order goes straight through.

## Price protection

Every market order carries a limit price that you sign. By default the app sets it 8 basis points (0.08%) beyond the firm quote: above it for a long, below it for a short. On a $250 position that is 20 cents of room.

The protection is enforced by the contract. If the price the maker approves is worse than your limit, or the fee is higher than the maximum you signed, the contract rejects the trade. The venue's servers cannot widen your protection after you sign, and they cannot fill you at a worse price. A fill at a better price can carry a slightly larger fee, and the maximum fee you sign allows for that.

In Advanced view, **Options** → **Max slippage** lets you choose 0.05%, 0.08%, 0.25%, 0.5% or 1%. Tighter protection fails more often when the price moves between your click and the trade's inclusion; wider protection fills more often at a possibly worse price. Either way a failed trade costs nothing. Integrators can choose any protection from 1 to 500 basis points with `slippageBps` on the [quote endpoint](../integrate/api.md#trading).

## What happens after you click

1. **Getting a firm quote.** The app asks the venue for a quote for your exact size. In the review sheet the price is held for about 30 seconds; the app stops offering it a moment before it lapses so there is time to sign.
2. **Confirm in your wallet.** You sign a *TradeIntent*: your account, the market, the exact size in base units, your limit price, the maximum fee, a random one-time nonce and a deadline 30 seconds away. With [one-click trading](one-click-trading.md) on, the app signs instantly with your session key instead.
3. **Collecting approver signatures.** The venue re-prices your trade against a fresh oracle report. If the new price is still inside your limit, it reserves the maker's capacity for your trade and asks three independent approvers to check and co-sign it. Two signatures are enough.
4. **Settlement.** The venue simulates the transaction, submits it to Base and pays the gas. The contract verifies everything again and settles the trade.

The notice at the edge of the screen follows these steps and ends with the fill price, the block number and a link to the transaction. A trade usually completes a few seconds after you sign.

Only one action runs at a time. Wait for the notice to finish before placing another trade.

## Fees

The trading fee is 2 basis points (0.02%) of the trade's notional, charged in USDC from your collateral when the trade settles. A 25 USDC trade pays half a cent. The maker's spread is separate and is already included in the price. [Pricing and fees](../risk/pricing-and-fees.md) explains both.

There is no gas cost to you for trading. The venue pays it.

## When a trade is refused

A refused trade costs nothing. Nothing is signed into the contract until settlement, and the nonce you signed is only used up if the trade settles. The ticket explains problems before you click; the notice explains anything the venue refuses after.

| Message | What it means | What to do |
| --- | --- | --- |
| **Waiting for a fresh price** | The app has not had a recent price update. | Wait a moment. If it persists, the price stream is down. |
| **Over the per-trade limit** | Your position is above the market's per-trade limit. | Pay less, lower the leverage, or split the trade. |
| **Up to N× at this size** | The leverage is above what the margin tier allows for this position. | Pick a lower leverage or pay less. |
| **Long is closed right now** (or Short) | The maker is only accepting trades in the other direction in this market. | Trade the other direction, close, or wait. |
| **Paused · closing only** | The market is paused. Only trades that reduce your position are accepted. | Trade in the opposite direction of your position, no larger than it, or close it. |
| **Add funds** | The trade would leave your account below its initial margin. | Deposit more, or pay less or lower the leverage. |
| **The price moved past your price protection** | The fresh price at approval time was worse than your limit. | Try again, or allow more slippage in Options. |
| **The price expired before it was signed** | Too much time passed between the quote and your signature. | Try again and sign promptly. |
| **This direction is closed for now** | The maker is at a risk limit or its hedging is unavailable, so only trades that reduce its exposure are accepted. | Trade the other direction, close, or wait. |
| **The venue is busy right now** | The maker has no spare capacity in this direction, or you sent too many requests. | Wait a moment and retry, or trade a smaller size. |
| **The trade couldn't be confirmed right now** | Fewer than two approvers answered, or the final check before submission failed. | Wait and retry. Your funds are unaffected. |
| **Trading paused** | All trading is paused. Closing at the oracle price and withdrawals still work. | See [Safety and exits](../protocol/safety-and-exits.md). |

A trade that is refused for capacity reasons is not a malfunction. The maker has hard limits on how much risk it can carry, and the venue refuses risk it cannot back rather than accepting it and hoping. [Markets and limits](../markets/markets-and-limits.md) describes those limits.

## Reduce only

In Advanced view, tick **Reduce only** when a trade must not open new risk, for example when you are trimming a position near its limit. A reduce-only trade must make your position strictly smaller and cannot flip its direction. If it would, the contract rejects it. Reductions are also allowed in situations where opening trades are not: on a paused market, when the maker is over a limit, or when your account is between its initial and maintenance margin.

Closing a position from its **Close** button always sends a reduce-only trade, so you do not need to tick the box for that. See [Positions](positions.md#closing-a-position).
