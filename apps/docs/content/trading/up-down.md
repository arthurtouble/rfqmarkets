# Up / Down

Up / Down is the app's home screen. You pick an amount and a multiplier, then say whether the price goes up or down. The address is `/updown/` and the market, for example `/updown/ETH`.

## Making a trade

1. Choose the market from the name at the top.
2. Pick an **amount** in USDC. Type one, or tap **$10**, **$25**, **$50** or **$100**.
3. Pick a **multiplier**: **2×**, **3×**, **5×** or **10×**. Only the choices up to the market's maximum are shown.
4. Tap **Up** if you think the price will rise, or **Down** if you think it will fall.

The line under the multiplier shows the size of the position and what a 1% move your way would earn. For example, $10 at 5× is a $50 position, and a 1% move your way earns about 50 cents.

If a button is greyed out, the line under it says why, for example "Prices are catching up" or the most one trade allows at that multiplier. If you have no money in your account, the buttons are replaced by **Add money**.

## What a trade is

An Up / Down trade is a market order for a perpetual position of amount × multiplier. Up is a long and Down is a short. It is the same position you would open in Pro, so it also shows on Portfolio and in Pro.

There is no expiry and no timer. The trade stays open until you tap **Cash out**. Opening and cashing out each pay the 0.04% trading fee on the trade's size; the confirm sheet shows it.

You can lose the whole amount. If the price moves against you far enough, the trade closes on its own at the **auto-close price**, which is the liquidation price. The higher the multiplier, the closer that price: with only the amount in your account, a move of roughly 7% against you closes a 10× trade.

Your whole balance backs your trades, as it does in Pro. If you hold more than the amount, the auto-close price sits further away, and a trade left open until it gets there can lose more than the amount. The app works the price out from your actual balance. [Margin](../risk/margin.md) and [Liquidation](../risk/liquidation.md) explain the rules.

Funding is paid or received while the trade is open, as with any position. See [Funding](../risk/funding.md).

## The first trade

Before the first trade in a browser, **Start trading** stands in for the Up and Down buttons. Tap it and sign once in your wallet to [connect](connecting-to-trade.md). The app says "Connection established. You can start trading."

From then on every trade fills on a tap, with no sheet and no wallet prompt. If the price moves before the trade settles, nothing is traded.

When a trade fills, a notice says, for example, "You're Up on Ethereum with $10".

## While it is open

Home shows the open trade for that market:

- what it has made or lost, in dollars and as a percentage of your amount;
- the entry price and the auto-close price;
- **Cash out**, which shows the current result on the button;
- **Share**.

**Cash out** closes the whole position at the current price. It signs with your trading key, and asks your wallet if the key cannot, so you can always cash out. The result goes into your balance.

If you opened a position in this market from Pro, Home shows that position the same way.

## After you cash out

Home shows the result: what you made or lost, the entry price and the price you got out at. **Share** draws an image card of the trade. **New trade** takes you back to the amount and multiplier.

## Sharing

Both an open trade and a cashed-out result can be shared. **Share** draws an image card with the market, Up or Down, the multiplier, the entry price and the result. Share it, save it as an image or copy the text. The card shows no wallet address.

## Money

On a phone, your balance sits at the top of Home. Tap it for **Add money** and **Withdraw**. On a computer, use **Deposit** in the top bar. [Deposits and withdrawals](deposits-and-withdrawals.md) covers both.

## When you want more

Tap **Pro** at the top of Home to open the full trading screen for the same market. It has higher leverage, limit and stop orders, take profit and stop loss, **Close only**, slippage settings and candlestick charts. See [Placing a trade](placing-a-trade.md).
