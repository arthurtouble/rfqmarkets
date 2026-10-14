# Quick start

This page takes you from an empty wallet to your first trade and back out again. It takes about five minutes.

You need:

- **A wallet.** A browser extension such as Rabby, MetaMask or Coinbase Wallet, a phone wallet through WalletConnect, or nothing at all: Base Account creates a wallet for you with a passkey.
- **USDC on Base.** It has to be native USDC issued by Circle on Base, not bridged USDbC. The first deposit must be at least 10 USDC.
- **A little ETH on Base** for the deposit transactions. Everything after the deposit is gas-free.

> **Warning.** This is a development deployment with real money and unaudited contracts. Keep amounts small. Trades are capped at 25 USDC each for now.

## 1. Connect

Open the app at [dev.rfq-markets.workers.dev](https://dev.rfq-markets.workers.dev). It opens on **Home**, the Up / Down screen. Click **Connect** in the top right, or **Connect to trade** on Home. Pick your browser wallet, **Base Account** to sign in with a passkey, or **WalletConnect** to scan a QR code with your phone. [Using the app](using-the-app.md#connecting-a-wallet) explains each option.

If your wallet is on another network, the button changes to **Switch to Base**. Click it and approve the switch in your wallet. The app also asks for the switch automatically whenever it needs a signature.

## 2. Deposit

Click **Deposit** in the top bar, or **Add money** on Home. On a phone, tap your balance at the top of Home, then **Add money**. Enter an amount, or click **Max** to use your whole wallet balance, then click **Deposit**.

Your wallet asks for two things in turn:

1. **Approve USDC.** This lets the clearing contract take exactly the amount you entered, no more. If you have already approved enough, this step is skipped.
2. **Confirm the deposit.** This moves the USDC into the contract and credits it to your account.

Both are ordinary transactions, so you pay a small amount of ETH for gas. When the deposit confirms, your balance updates. In Pro, the **Account value** card also shows how much is **Available to trade**.

## 3. Make a trade

Home shows one market at a time. Switch between **Bitcoin** and **Ethereum** from the name at the top.

1. Pick an amount: tap **$10**, or type any amount.
2. Pick a multiplier: **2×**, **3×**, **5×** or **10×**. Your position is the amount times the multiplier: $10 at 2× is a $20 position. Positions are capped at 25 USDC per trade for now, so $10 at 3× is too big. The line under the buttons shows the position and what a 1% move your way would earn.
3. Tap **Up** if you think the price will rise, or **Down** if you think it will fall.

The first time, a sheet titled **Up on Bitcoin** (or **Down on Bitcoin**) shows the price and the **Auto-closes at** price. If the price reaches that level, the trade closes and you lose your amount. Tap **Confirm Up** and sign in your wallet.

Your wallet shows a typed-data signature request titled *TradeIntent*. It lists the account, market, size, the worst price you accept, a maximum fee of zero, a nonce and a deadline about 30 seconds away. Signing is free. The app then collects the approvers' signatures and submits the trade. A notice says "You're Up on Bitcoin with $10" and links to the transaction.

Leave **Skip this next time** ticked if you want later trades to fill on a tap. Your wallet asks for one more signature to turn on [one-tap trading](../trading/one-tap-trading.md).

## 4. Watch the trade

Home now shows your trade: what it has made or lost, in dollars and as a percentage of your amount, with the entry price and the auto-close price. There is no timer. The trade stays open until you cash out.

The **Portfolio** page shows your whole account: account value, margin in use, a chart of your profit or loss, and every position and trade. [Positions and your account](../trading/positions.md) explains each figure.

## 5. Cash out

Tap **Cash out** on Home. The trade closes at the current price and the result goes into your balance. Home shows what you made, with **Share** to send an image of it and **New trade** to start again.

A cash-out can only close your position. It can never open one the other way.

## 6. Withdraw

Click **Withdraw** in Pro or on Portfolio. On a phone you can also tap your balance on Home, then **Withdraw**. Enter an amount up to what is available and confirm. You sign one message and the venue pays the gas. The USDC arrives in your wallet as soon as the transaction is included, usually within a few seconds.

## What next

- Read [Up / Down](../trading/up-down.md) for how Home works in detail.
- Tap **Pro** on Home for the full ticket: higher leverage, [limit orders](../trading/limit-orders.md), [stop orders](../trading/stop-orders.md) and **Close only**. [Placing a trade](../trading/placing-a-trade.md) explains it.
- Read [Margin](../risk/margin.md) and [Liquidation](../risk/liquidation.md) before you use a high multiplier. Pro allows up to 20×; at 20× a 2% move against you closes the trade.
