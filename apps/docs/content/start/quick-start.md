# Quick start

This page takes you from an empty wallet to an open position and back out again. It should take about five minutes.

You need:

- A browser wallet such as Rabby, MetaMask or Coinbase Wallet. The app finds wallets that announce themselves in the browser. WalletConnect and mobile wallets are not supported yet.
- **USDC on Base.** It has to be native USDC issued by Circle on Base, not bridged USDbC. The first deposit must be at least 10 USDC.
- **A little ETH on Base** for the deposit transaction. Everything after the deposit is gas-free.

> **Warning.** This is a development deployment with real money and unaudited contracts. Keep amounts small. Trades are capped at 25 USDC each for now.

## 1. Connect

Open the app at [dev.rfq-markets.workers.dev](https://dev.rfq-markets.workers.dev) and click **Connect wallet** in the top right. Pick your wallet from the list.

If your wallet is on another network, the button changes to **Switch to Base**. Click it and approve the switch in your wallet. The app also asks for the switch automatically whenever it needs a signature.

## 2. Deposit

On the trade page, find the **Account** card and click **Deposit**. Enter an amount, or click **Max** to use your whole wallet balance, then click **Approve and deposit**.

Your wallet asks for two things in turn:

1. **Approve USDC.** This lets the clearing contract take exactly the amount you entered, no more. If you have already approved enough, this step is skipped.
2. **Confirm the deposit.** This moves the USDC into the contract and credits it to your account.

Both are ordinary transactions, so you pay a small amount of ETH for gas. When the deposit confirms, the Account card shows your **Collateral** and **Available margin**.

## 3. Place a trade

The order ticket sits on the right of the trade page.

1. Choose the market at the top of the page: **BTC-PERP** or **ETH-PERP**.
2. Choose **Buy / Long** if you expect the price to rise, or **Sell / Short** if you expect it to fall.
3. Leave the order type on **Market**.
4. Enter a **Size** in USDC. This is the notional value of the position, not your collateral. A 20 USDC buy of BTC opens a long worth 20 USDC of BTC, and needs 4 USDC of margin at the 20% initial margin rate.
5. Check the estimate under the size: the **Estimated price**, the **Maximum accepted price** (or minimum, for a sell), the size in BTC or ETH, and the **Fee (max)**.
6. Click **Buy BTC** (or **Sell ETH**, and so on).

Your wallet shows a typed-data signature request titled *TradeIntent*. It lists the account, market, size, the limit price, the maximum fee, a nonce and a deadline about 30 seconds away. Signing is free. Once you sign, the app collects the approvers' signatures and submits the trade, and a notice in the corner shows the fill price and block.

## 4. Watch the position

The **Positions** tab under the chart shows your open position: its size, entry price, the current mark, the unrealized profit or loss, funding accrued so far and an estimated liquidation price.

The **Account** card shows your account as a whole: equity, available margin, margin usage, effective leverage and the buffer you have before liquidation. [Positions](../trading/positions.md) explains each figure.

## 5. Close

Click **Close** on the position's row. The app asks the maker for an exact quote to close the whole position, and your wallet asks you to sign it. The close is a reduce-only trade, so it can never accidentally open a position the other way.

## 6. Withdraw

Click **Withdraw** on the Account card, enter an amount up to your available margin, and click **Sign and withdraw**. You sign one message and the venue pays the gas. The USDC arrives in your connected wallet as soon as the transaction is included, usually within a few seconds.

## What next

- Read [Placing a trade](../trading/placing-a-trade.md) to understand price protection and why a trade can be refused.
- Turn on [Quick trading](../trading/quick-trading.md) if you trade often and want to skip the wallet prompt.
- Read [Margin](../risk/margin.md) and [Liquidation](../risk/liquidation.md) before you use leverage.
