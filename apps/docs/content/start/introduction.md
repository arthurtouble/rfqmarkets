# Introduction

RFQ Markets is a perpetual futures venue on Base. You trade BTC and ETH against a single market maker, you post USDC as collateral, and every trade settles in a smart contract that holds the money and enforces the rules.

There is no order book. When you go long or short, the venue asks its market maker for a firm price for exactly the size you entered, checks that price against an independent oracle, gets it co-signed by two of three independent approvers, and submits it on chain. You sign once, and the venue pays the gas.

The point of this design is a clean trading experience without giving up custody. The prices come from a request-for-quote (RFQ) model, the way large trades are done in traditional markets, but your collateral never leaves the contract, and the contract refuses any fill that is worse than the price you signed.

> **Warning.** RFQ Markets is in development. It runs on Base mainnet with real USDC, but trading is capped at tiny sizes, the contracts have not been audited, and one operator key can still change or upgrade them. Only deposit what you are prepared to lose. See [Current status](#current-status) below.

## What you can do

- **Trade BTC and ETH perpetuals** with up to 20x leverage, long or short, around the clock. Markets are open 24/7; there is no session close and no weekend gap. New markets are listed by governance without a new release of the app.
- **Use one pool of USDC for every market.** Margin is shared across your positions, so you do not have to fund each one separately.
- **Place market orders or resting limit orders.** A market order fills at once, all or nothing, within a price protection you sign. A limit order waits until the maker's executable price reaches your limit.
- **Connect the way you like**: a browser wallet, a phone wallet through WalletConnect, or a passkey with Base Account, which needs nothing installed.
- **Trade without wallet pop-ups** by turning on one-click trading, a short-lived session key that can trade within limits the contract enforces and can never withdraw.
- **Withdraw any time** your margin allows, with one signature and no gas.
- **Leave without the venue.** If the venue's servers disappear, your wallet can still withdraw, cancel and claim directly from the contract through the exit page.

## How it differs from an order-book exchange

On a central limit order book, your order meets other traders' orders, and the price you get depends on how much resting liquidity there is at each level. On RFQ Markets your counterparty is always the venue's market maker, and the price is computed for your exact size.

That has a few practical consequences:

- **You see one price for your size.** The ticket shows the estimated fill for the amount you typed, including spread, fee and the effect of your size. There is no walking the book.
- **Fills are all or nothing.** A market order either fills completely within your protection or not at all. There are no partial fills.
- **The maker can say no.** The maker has hard limits on how much risk it can take on. When a market is near its limit, trades that add to the maker's exposure may be refused while trades that reduce it go through. [Markets and limits](../markets/markets-and-limits.md) explains these limits.
- **The maker hedges.** The maker offsets its net exposure on external venues. This is the maker's business, not yours, but it affects pricing and is described in [Hedging](../protocol/hedging.md).

## How a trade is protected

Four separate parties have to agree before a trade settles:

1. **You** sign the exact trade: market, size, the worst price you accept, the maximum fee and a short deadline.
2. **The oracle** supplies a price report signed by at least two of three independent price nodes, each of which aggregates prices from seven exchanges.
3. **Two of three approvers** each check the quote independently against the oracle, the contract's state and the venue's risk policy, and co-sign it.
4. **The contract** verifies all of the above again, plus your margin and the venue's risk limits, and only then moves any money.

No single server can trade on your behalf, and no one can fill you outside the price you signed. [How a trade settles](../protocol/settlement.md) walks through the whole path.

## Current status

RFQ Markets is a development deployment that happens to run on Base mainnet rather than a testnet, so that it can be tested with real assets. It is not a launched product. As of October 2026:

| Area | Today | Planned for production |
| --- | --- | --- |
| Trade size | 25 USDC per trade, 100 USDC net per market | Raised in stages after review |
| Contracts | Unaudited | Independent audit before launch |
| Governance | One operator key, changes take effect immediately | Multisig behind a 72-hour timelock |
| Hedging | Simulated; no external orders are placed | Live hedging, Hyperliquid first |
| Liquidation keepers | Permissionless, but no operator keeper is running yet | Independent keepers |
| Markets | BTC and ETH, up to 20x | More 24/7 crypto markets, added by governance |
| Stop loss and take profit | Supported by the contract and API, not yet in the app | In the app |

Everything in these docs describes the product as it works today, and calls out where production will differ.

## Where to go next

- New here? Start with the [Quick start](quick-start.md), then [Using the app](using-the-app.md).
- Confused by the different prices on screen? Read [Prices explained](prices-explained.md).
- Building something? Go to the [API overview](../integrate/api.md).
