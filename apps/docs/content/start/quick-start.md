# Quick start

This page takes you from an empty wallet to an open position and back out again. It should take about five minutes.

You need:

- **A wallet.** A browser extension such as Rabby, MetaMask or Coinbase Wallet, a phone wallet through WalletConnect, or nothing at all: Base Account creates a wallet for you with a passkey.
- **USDC on Base.** It has to be native USDC issued by Circle on Base, not bridged USDbC. The first deposit must be at least 10 USDC.
- **A little ETH on Base** for the deposit transactions. Everything after the deposit is gas-free.

> **Warning.** This is a development deployment with real money and unaudited contracts. Keep amounts small. Trades are capped at 25 USDC each for now.

## 1. Connect

Open the app at [dev.rfq-markets.workers.dev](https://dev.rfq-markets.workers.dev) and click **Connect** in the top right. Pick your browser wallet, **Base Account** to sign in with a passkey, or **WalletConnect** to scan a QR code with your phone. [Using the app](using-the-app.md#connecting-a-wallet) explains each option.

If your wallet is on another network, the button changes to **Switch to Base**. Click it and approve the switch in your wallet. The app also asks for the switch automatically whenever it needs a signature.

## 2. Deposit

Click **Deposit**, or **Add funds to trade** on the ticket. Enter an amount, or click **Max** to use your whole wallet balance, then click **Deposit**.

Your wallet asks for two things in turn:

1. **Approve USDC.** This lets the clearing contract take exactly the amount you entered, no more. If you have already approved enough, this step is skipped.
2. **Confirm the deposit.** This moves the USDC into the contract and credits it to your account.

Both are ordinary transactions, so you pay a small amount of ETH for gas. When the deposit confirms, the **Account value** card shows your balance and how much is **Available to trade**.

## 3. Place a trade

The order ticket sits on the right of the trade page. On a phone, tap **Long** or **Short** at the bottom of the screen to open it.

1. Choose the market from the name above the chart: **BTC** or **ETH**.
2. Choose **Long** if you expect the price to rise, or **Short** if you expect it to fall.
3. Enter the amount in USDC. This is the size of the position, not your collateral. A 20 USDC long on BTC opens a position worth 20 USDC of BTC, and needs 1 USDC of margin at the 5% initial margin rate.
4. Check the **Entry price**, the **Fee** and your **Leverage after** under the amount.
5. Click **Long BTC · $20.00** (or the equivalent).

A **Review order** sheet restates the trade with its price protection, which is the worst price you accept. Leave the one-click trading box ticked if you want later trades to skip this step, then click **Confirm and sign**.

Your wallet shows a typed-data signature request titled *TradeIntent*. It lists the account, market, size, the limit price, the maximum fee, a nonce and a deadline about 30 seconds away. Signing is free. Once you sign, the app collects the approvers' signatures and submits the trade, and a notice shows the fill price and a link to the transaction.

## 4. Watch the position

The **Positions** tab under the chart shows your open position: its value, entry price, the current mark, the estimated liquidation price and the profit or loss. The **Portfolio** page shows your whole account: account value, margin in use, leverage and every position. [Positions and your account](../trading/positions.md) explains each figure.

## 5. Close

Click **Close** on the position. Pick how much to close, from 25% to 100%, check the estimated price and profit, and confirm. The close is a reduce-only trade, so it can never accidentally open a position the other way.

## 6. Withdraw

Click **Withdraw** on the Account value card, enter an amount up to what is available, and click **Withdraw**. You sign one message and the venue pays the gas. The USDC arrives in your connected wallet as soon as the transaction is included, usually within a few seconds.

## What next

- Read [Placing a trade](../trading/placing-a-trade.md) to understand price protection and why a trade can be refused.
- Turn on [One-click trading](../trading/one-click-trading.md) if you trade often and want to skip the wallet prompt.
- Switch to the Advanced view for [limit orders](../trading/limit-orders.md) and reduce-only trades.
- Read [Margin](../risk/margin.md) and [Liquidation](../risk/liquidation.md) before you use leverage. Up to 20x is allowed; at 20x a 2% move liquidates you.
