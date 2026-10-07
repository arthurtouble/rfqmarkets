# Using the app

The app at [dev.rfq-markets.workers.dev](https://dev.rfq-markets.workers.dev) has four places: **Trade**, **Markets**, **Portfolio** and **Account**. This page covers connecting a wallet, the two views, how the layout changes on a phone, and the settings you can change.

## Connecting a wallet

Click **Connect** in the top right, or **Connect to trade** on the ticket. The **Connect a wallet** dialog groups your options:

| Section | Option | When to use it |
| --- | --- | --- |
| **Installed** | Your browser extension, such as Rabby, MetaMask or Coinbase Wallet | You already have a wallet in this browser. Every extension that announces itself is listed by name. |
| **No wallet yet** | **Base Account** | You have no wallet. It signs in with a passkey on your device, so there is nothing to install and no seed phrase to write down. |
| **Phone and other wallets** | **WalletConnect** | Your wallet is on your phone, or is one of the hundreds of wallets WalletConnect supports. Scan the QR code it shows with your wallet app. |

If the dialog finds no browser extension, it says so and links to a few wallets you can install.

RFQ Markets never holds your keys. Your wallet signs each order, and the venue only ever sees signatures.

### The right network

Everything happens on Base. If your wallet is on another network, the wallet button becomes **Switch to Base**. Click it and approve the switch in your wallet. The app also asks for the switch automatically whenever it needs a signature or a transaction.

### Passkey and smart wallets

Base Account, and other smart-contract wallets, work the same way as an ordinary wallet. The contract checks their signatures through the standard for contract signatures (ERC-1271), which only works once the wallet's contract exists on Base. A new smart wallet is created by its first transaction, and on RFQ Markets that is your first deposit, so deposit before you try to trade or withdraw.

### The wallet menu

Once you are connected, the wallet button shows your account value. Click it to see the connected network and address, copy the address, open it on the block explorer, go to **Settings** (the Account page) or **Disconnect**.

## Simple and Advanced

The app has two views, and you can switch between them at any time.

- **Simple**, the default, shows what most trades need: direction, amount, the expected entry price, the fee and your leverage after the trade. Every order is a market order.
- **Advanced** adds [limit orders](../trading/limit-orders.md), **Reduce only**, the price protection, spread and inventory adjustment on the ticket, the bid, ask and limits for each market, funding on each position, and more detail on the Markets page.

Switch with **View** in the top bar on a computer, or under **Account** on a phone. The choice is saved in this browser. Switching back to Simple resets the ticket to a market order with Reduce only off.

## On a phone

Below 900 pixels wide, the top bar gives way to a tab bar at the bottom of the screen with **Trade**, **Markets**, **Portfolio** and **Account**.

On the trade page, the chart and your position in that market sit at the top, and two buttons, **Long** and **Short**, stay at the bottom of the screen. Tapping either opens the order ticket as a sheet. Your other markets' positions, your orders and your history are under **Portfolio**.

## The pages

- **Trade** shows one market: the price and a chart of recent prices, the market's funding rate and maximum trade, the order ticket, your account value and, underneath, your positions, orders and trades. Switch markets from the market name above the chart. The app remembers the last market you opened.
- **Markets** lists every market with its price, recent change and funding rate, plus venue-wide open interest and recent trades. See [Positions and your account](../trading/positions.md#the-markets-page).
- **Portfolio** is your account in full: account value, margin in use and leverage, a chart of your profit or loss with realized PnL, fees, funding and volume, then every position (with **Close all**), order, trade, funding payment and transfer. See [Positions and your account](../trading/positions.md).
- **Account** holds your wallet, [one-click trading](../trading/one-click-trading.md), the view and appearance settings, a link to these docs and a link to the [emergency exit page](../protocol/safety-and-exits.md#the-exit-page).

## Appearance

Under **Account**, **Appearance** offers **System**, **Light** and **Dark**. System, the default, follows your device's setting. The choice is saved in this browser. These docs have the same switch in their top bar.

## Notices

Every action you take, from a trade to a withdrawal, shows a notice at the edge of the screen. It follows the action through its steps, ends with the result and a link to the transaction, and disappears after a few seconds. An error stays a little longer and says what went wrong, for example "Trade failed" followed by the reason. [Placing a trade](../trading/placing-a-trade.md#when-a-trade-is-refused) lists the common reasons.

The app also shows banners above the ticket when a market is not trading normally:

| Banner | Meaning |
| --- | --- |
| **Bitcoin is paused.** You can still close a position. | Trading in that market is paused. |
| **Only closing trades right now.** | The maker's hedging is unavailable, so only trades that reduce positions are accepted. |
| Trade sizes are smaller than usual while our hedge catches up. | The maker is limiting new risk until its hedge is back in line. |
