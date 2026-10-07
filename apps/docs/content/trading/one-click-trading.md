# One-click trading

One-click trading lets you place market orders and closes without a wallet prompt for each one. You authorize a temporary session key once, with limits the contract enforces, and the app signs trades with that key until it expires.

## Turning it on

There are two ways:

- **From the review sheet.** When you place a market order without a session, the **Review order** sheet has a box, ticked by default, that reads "Then turn on one-click trading". Leave it ticked and your wallet asks for one more signature after the trade.
- **From the Account page.** Open **Account** (on a computer, through **Settings** in the wallet menu; on a phone, from the tab bar) and click **Turn on** in the **One-click trading** row.

Either way, the app generates a fresh key in your browser tab and your wallet asks you to sign a *SessionGrant*. The venue submits the grant on chain and pays the gas. When it is active, the row reads "On until" a time, and the ticket shows "One-click trading is on. No wallet prompt." under the button for any order the session covers.

The session the app creates has fixed limits:

| Limit | Value |
| --- | --- |
| Markets | Every market listed when you turn it on |
| Largest single trade | 2,500 USDC |
| Total traded over the session | 10,000 USDC |
| Highest fee on any one trade | 5 USDC |
| Duration | 8 hours |

While the venue's per-trade cap is 25 USDC, the cap is the tighter limit in practice. A market listed after you turned one-click trading on is not covered; turn it off and on again to include it.

## What it can and cannot do

The session key signs **market orders and closes** within those limits while the session has more than 30 seconds left. It is not used for limit orders, cancellations, deposits or withdrawals; those always go to your wallet. Anything outside the limits, such as a close bigger than 2,500 USDC, also goes to your wallet.

The limits are checked by the clearing contract on every trade, not just by the app. A session key cannot:

- trade outside its markets, size limits, fee limit or expiry;
- withdraw collateral, or send it anywhere;
- cancel orders, close positions through the paused-trading path, or grant or revoke sessions;
- be used by a different account.

So the worst a stolen session key can do is trade your account, within those limits, until it expires or you turn it off. That can still lose money, but it cannot take your collateral.

## Where the key lives

The session's private key is held only in the memory of the browser tab that created it. It is never sent to the venue and never written to disk. The tab remembers the session's public address so that it can show you the session and let you turn it off.

That means **reloading the tab or opening another one loses the key**. The grant itself is still valid on chain until it expires. The One-click trading row then says "Reloading the page cleared this tab's key" and offers **Turn off** and **Turn on**. Turning it on again creates a new key; the old grant stays valid until it expires unless you turn it off, but with its key gone nothing can sign with it.

## Turning it off

Click **Turn off** in the One-click trading row. This is a transaction from your own wallet to the clearing contract, so it costs a little gas; it is not sponsored. Once it confirms, the session key can no longer trade.

You do not need to turn off a session that has simply expired. You can also revoke any session address from the [exit page](../protocol/safety-and-exits.md).

## For integrators

The contract supports sessions of up to 30 days, with any set of markets and limits you choose. The fixed values above are only what the app requests. See [Signing](../integrate/signing.md#sessiongrant) for the grant's fields and the rules the contract applies.
