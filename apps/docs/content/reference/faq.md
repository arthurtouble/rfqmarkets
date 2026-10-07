# FAQ

## Is this live? Can I use it with real money?

It runs on Base mainnet with real USDC, but it is a development deployment: trades are capped at 25 USDC, the contracts are unaudited, and one operator key controls them. You can use it, but only with money you are prepared to lose. See [Current status](../start/introduction.md#current-status).

## Who is on the other side of my trade?

The venue's market maker, always. There is no order book and no other trader is matched against you. The maker hedges its net exposure externally. See [Hedging](../protocol/hedging.md).

## Can the venue take my collateral?

Not through any normal function. Your collateral can only leave the contract through a withdrawal you signed, a trade you signed (as losses and fees), funding, or a liquidation the contract's rules allow. The honest caveat is upgrades: today a single operator key can upgrade the contract, and upgraded code could in principle do anything. Production plans to put upgrades behind a multisig and a 72-hour delay. See [Governance](../protocol/governance.md).

## Can I be filled at a worse price than I saw?

Not worse than the price protection you signed, which the app sets 8 bps beyond the firm quote. The contract enforces that. You can be filled at a slightly different price from the on-screen estimate, but only within that bound, and often at the estimate itself.

## Why was my trade refused?

Usually one of three reasons: the price moved more than 8 bps before settlement, you did not have enough margin, or the maker had no room for more exposure in that direction. None of them cost you anything. [Placing a trade](../trading/placing-a-trade.md#when-a-trade-is-refused) lists every message.

## Why are the limits so small?

Because the venue is in development and its maker has about 100 USDC of capital. Limits will rise in stages after an audit, a governance timelock and live hedging are in place.

## What leverage can I use?

Up to 20x on BTC and ETH for positions up to 25,000 USDC, less for larger ones. Governance sets the margin rates per market, so a newly listed market may allow less. There is no leverage setting on a position; your leverage is your position size relative to your account value, and the ticket shows it before you trade. See [Margin](../risk/margin.md).

## Do I pay gas?

Only to deposit, and to turn off one-click trading. Trades, closes, withdrawals, order cancellations and turning one-click trading on are paid by the venue.

## What wallets work?

Browser extensions such as Rabby, MetaMask and Coinbase Wallet; phone wallets through WalletConnect; and Base Account, which creates a wallet with a passkey and needs nothing installed. Smart-contract wallets work once their first transaction, usually your first deposit, has created them on Base. See [Using the app](../start/using-the-app.md#connecting-a-wallet).

## Can I set a stop loss or take profit?

Yes. Click **TP/SL** on the position, enter a take-profit price, a stop-loss price or both, and sign. Whichever fills first cancels the other. A stop protects your price, not your exit: if the price gaps past the slippage band, it waits for the price to come back. See [Stop loss and take profit](../trading/stop-orders.md).

## Can I close part of a position?

Yes. **Close** offers 25%, 50%, 75% or 100% of the position. **Close all** closes every position at once.

## Does it work on a phone?

Yes. The app has a phone layout with a tab bar at the bottom, and you can connect a phone wallet through WalletConnect or use Base Account with a passkey.

## Is it open on weekends?

Yes. Every market trades 24/7, and the venue only lists assets with continuous prices.

## Where do the prices come from?

The venue's own oracle: three nodes in different regions, each taking the median of seven exchanges every second, with two of three required to agree. See [Price oracle](../markets/price-oracle.md).

## What happens if the website goes down?

Your money stays in the contract. Use the [exit page](../protocol/safety-and-exits.md#the-exit-page) to withdraw, cancel orders or revoke sessions directly from your wallet.

## Are my trades private?

No. Like everything on Base, deposits, trades and positions are public and linked to your wallet address. The venue does not ask for or store any personal information.

## Can I trade with code?

Yes. The API the app uses is open; see the [API overview](../integrate/api.md).
