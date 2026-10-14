# Using the app

The app at [dev.rfq-markets.workers.dev](https://dev.rfq-markets.workers.dev) has four places: **Home**, **Markets**, **Portfolio** and **Account**. Home is the Up / Down screen, the quickest way to trade. **Pro** is the full trading screen, one tap away. This page covers both, connecting a wallet, the layout on a phone and the settings you can change.

## Connecting a wallet

Click **Connect** in the top right, or **Connect to trade** on Home or the Pro ticket. The **Connect a wallet** dialog (a sheet from the bottom of the screen on a phone) groups your options:

| Section | Option | When to use it |
| --- | --- | --- |
| **Installed** | Your browser extension, such as Rabby, MetaMask or Coinbase Wallet | You already have a wallet in this browser. Every extension that announces itself is listed by name. |
| **No wallet yet** | **Base Account** | You have no wallet. It signs in with a passkey on your device, so there is nothing to install and no seed phrase to write down. |
| **Phone and other wallets** | **WalletConnect** | Your wallet is on your phone, or is one of the hundreds of wallets WalletConnect supports. Scan the QR code it shows with your wallet app. |

If the dialog finds no browser extension, it says so and links to a few wallets you can install. On a phone it suggests opening the page in your wallet app's own browser, or using WalletConnect, which opens the wallet app directly.

If you cancel in your wallet, or the wallet cannot connect, the dialog says why in one line and you can pick again. A wallet window you closed without answering never blocks the others.

RFQ Markets never holds your keys. Your wallet signs each order, and the venue only ever sees signatures.

### The right network

Everything happens on Base. If your wallet is on another network, a **Switch to Base** button appears next to the wallet button, and the Account page shows the same warning with a **Switch** button. Click it and approve the switch in your wallet; if the wallet refuses, a notice says why. The app also asks for the switch automatically whenever it needs a signature or a transaction.

### Passkey and smart wallets

Base Account, and other smart-contract wallets, work the same way as an ordinary wallet. The contract checks their signatures through the standard for contract signatures (ERC-1271), which only works once the wallet's contract exists on Base. A new smart wallet is created by its first transaction, and on RFQ Markets that is your first deposit, so deposit before you try to trade or withdraw.

### The wallet menu

Once you are connected, the wallet button shows your account value. Click it to see which wallet is connected, its address and network, copy the address, open it on the block explorer, go to **Account settings** (marked "One tap on" while [one-tap trading](../trading/one-tap-trading.md) is on) or **Disconnect**. If you switch accounts inside your wallet, the app follows.

## Home: Up / Down

Home opens on one market, at `/updown/BTC` for example, with its price and a chart of the last few minutes. Switch markets from the name at the top. The app remembers the last market you opened.

1. Pick an **amount**: type one, or tap **$10**, **$25**, **$50** or **$100**.
2. Pick a **multiplier**: **2×**, **3×**, **5×** or **10×**, up to the market's maximum. Your trade is a position of amount × multiplier, so $10 at 5× moves like $50 of ETH. The line under the buttons shows the position size and what a 1% move your way would earn.
3. Tap **Up** if you think the price will rise, or **Down** if you think it will fall.

A trade has no timer. It stays open until you tap **Cash out**. If the price moves far enough against you, it closes on its own at the auto-close price (the liquidation price) and you lose the amount. While a trade is open, Home shows its result live, the entry price and the auto-close price. After you cash out, Home shows what you made or lost, with **New trade** to start again. [Up / Down](../trading/up-down.md) has the details.

### Your first trade

The first time, a small sheet titled **Up on Ethereum** (or **Down on Bitcoin**, and so on) opens. It shows the price and the price the trade auto-closes at. Tap **Confirm Up** (or **Confirm Down**) and sign in your wallet.

The sheet has a **Skip this next time** box, ticked by default. Leave it ticked to turn on [one-tap trading](../trading/one-tap-trading.md): your wallet asks for one more signature, and after that trades within the one-tap limits fill on a tap, with no sheet and no wallet prompt. Home then shows "One tap, no wallet prompt." under the buttons.

### Sharing a trade

An open trade and a cashed-out result each have a **Share** button. It draws an image card with the market, direction, multiplier and result, which you can share or save.

### Money on a phone

On a phone, Home shows your balance at the top. Tap it for **Add money** and **Withdraw**. On a computer, **Deposit** sits in the top bar.

## Pro

Tap **Pro** on Home to open the full trading screen for the same market, at `/trade/BTC` for example. Pro shows everything at once:

- the order ticket with **Market**, **Limit** and **Stop** orders ([Placing a trade](../trading/placing-a-trade.md), [Limit orders](../trading/limit-orders.md), [Stop loss and take profit](../trading/stop-orders.md));
- **Options** on the ticket: **Close only** and **Max slippage**, plus the price protection you sign;
- a candlestick chart, from one minute to one day per candle, with the 24-hour high and low;
- the market's bid, ask, spread and maximum open per market;
- your positions, orders and trades underneath, with funding on each position.

Up / Down trades and Pro trades are the same positions. A trade opened on Home shows in Pro and on Portfolio, and a position opened in Pro shows on Home with its **Cash out** button.

## On a phone

Below 900 pixels wide, the top bar gives way to a tab bar at the bottom of the screen with **Home**, **Markets**, **Portfolio** and **Account**.

In Pro on a phone, the chart and your position in that market sit at the top, and two buttons, **Long** and **Short**, stay at the bottom of the screen. Tapping either opens the order ticket as a sheet. Your other positions, your orders and your history are under **Portfolio**.

## The pages

- **Home** is the Up / Down screen for one market, described above.
- **Markets** lists every market with its price, 24-hour change and funding rate, with a search box, plus venue-wide open interest and recent trades. Tap a market to open it on Home. Wider screens add more columns. See [Positions and your account](../trading/positions.md#the-markets-page).
- **Portfolio** is your account in full: account value, margin in use and leverage, a chart of your profit or loss with realized PnL, funding and volume, then every position (with **Close all**), order, trade, funding payment and transfer. See [Positions and your account](../trading/positions.md).
- **Account** holds your wallet, [one-tap trading](../trading/one-tap-trading.md), the appearance setting, a link to these docs and a link to the [emergency exit page](../protocol/safety-and-exits.md#the-exit-page).

## Appearance

Under **Account**, **Appearance** offers **System**, **Light** and **Dark**. System, the default, follows your device's setting. The choice is saved in this browser. These docs have the same switch in their top bar.

## Notices

Every action you take, from a trade to a withdrawal, shows a notice at the edge of the screen. It follows the action through its steps, ends with the result and a link to the transaction, and disappears after a few seconds. A trade from Home ends with a line such as "You're Up on Ethereum with $10". An error stays a little longer and says what went wrong in a short sentence, for example "The price moved. Nothing was traded. Try again." [Placing a trade](../trading/placing-a-trade.md#when-a-trade-is-refused) lists the common reasons.

In Pro, banners above the ticket show when a market is not trading normally:

| Banner | Meaning |
| --- | --- |
| **Bitcoin is paused.** You can still close a position. | Trading in that market is paused. |
| **Only closing trades right now.** | The maker's hedging is unavailable, so only trades that reduce positions are accepted. |
| Trade sizes are smaller than usual while our hedge catches up. | The maker is limiting new risk until its hedge is back in line. |
