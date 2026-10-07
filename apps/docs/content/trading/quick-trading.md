# Quick trading

Quick trading lets you place market orders without a wallet pop-up for each one. You authorize a temporary session key once, with limits the contract enforces, and the app signs trades with that key until it expires.

## Turning it on

On the Account card, find the **Quick trading** row and click **Enable**. The app generates a fresh key in your browser tab and your wallet asks you to sign a *SessionGrant*. The venue submits the grant on chain and pays the gas. When it is active, the row reads "On until" a time, and the ticket shows a **Quick** badge on orders the session will sign.

The session the app creates has fixed limits:

| Limit | Value |
| --- | --- |
| Markets | BTC and ETH |
| Largest single trade | 2,500 USDC |
| Total traded over the session | 10,000 USDC |
| Highest fee on any one trade | 5 USDC |
| Duration | 8 hours |

While the venue's per-trade cap is 25 USDC, the cap is the tighter limit in practice.

## What it can and cannot do

The session key can sign **market orders** of 2,500 USDC or less while the session has more than 30 seconds left. It is not used for limit orders, closes, cancellations, deposits or withdrawals; those always go to your wallet.

The limits are checked by the clearing contract on every trade, not just by the app. A session key cannot:

- trade outside its markets, size limits, fee limit or expiry;
- withdraw collateral, or send it anywhere;
- cancel orders, close positions through the paused-trading path, or grant or revoke sessions;
- be used by a different account.

So the worst a stolen session key can do is trade your account, within those limits, until it expires or you revoke it. That can still lose money, but it cannot take your collateral.

## Where the key lives

The session's private key is held only in the memory of the browser tab that created it. It is never sent to the venue and never written to disk. The tab remembers the session's public address so that it can show you the session and let you revoke it.

That means **reloading the tab or opening another one loses the key**. The grant itself is still valid on chain until it expires. The Quick trading row then says that reloading cleared this tab's session key and offers to revoke the old session or enable a new one. A new session gets a new key; the old grant stays valid until it expires unless you revoke it, but with its key gone nothing can sign with it.

## Revoking

Click **Revoke**. Revocation is a transaction from your own wallet to the clearing contract, so it costs a little gas; it is not sponsored. Once it confirms, the session key can no longer trade.

You do not need to revoke a session that has simply expired. You can also revoke any session address from the [exit page](../protocol/safety-and-exits.md).

## For integrators

The contract supports sessions of up to 30 days, with any market set and limits you choose. The fixed values above are only what the app requests. See [Signing](../integrate/signing.md#sessiongrant) for the grant's fields and the rules the contract applies.
