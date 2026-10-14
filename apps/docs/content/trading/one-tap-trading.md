# One-tap trading

One-tap trading lets you trade and cash out without a wallet prompt each time. You authorize a temporary session key once, with limits the contract enforces, and the app signs trades with that key until it expires.

## Turning it on

There are three ways:

- **From your first Up / Down trade.** The confirm sheet on Home has a **Skip this next time** box, ticked by default. Leave it ticked and your wallet asks for one more signature after the trade.
- **From the review sheet in Pro.** When you place a market order without a session, the **Review order** sheet has a **Skip this step next time** box, ticked by default. It works the same way.
- **From the Account page.** Open **Account** (on a computer, through **Account settings** in the wallet menu; on a phone, from the tab bar) and click **Turn on** in the **One-tap trading** row.

Each way, the app generates a fresh key in your browser tab and your wallet asks you to sign a *SessionGrant*. The venue submits the grant on chain and pays the gas. When it is active, the row reads "On until" a time. Home shows "One tap, no wallet prompt." and the Pro ticket shows "One-tap trading is on. No wallet prompt." for any trade the session covers.

The session the app creates has fixed limits:

| Limit | Value |
| --- | --- |
| Markets | Every market listed when you turn it on |
| Largest single trade | 2,500 USDC |
| Total traded over the session | 10,000 USDC |
| Highest fee on any one trade | 0.000001 USDC, the smallest the contract accepts, since trades carry no fee |
| Duration | 8 hours |

Each browser tab has its own session. While the venue's per-trade cap is 25 USDC, that cap is the tighter limit in practice. A market listed after you turned one-tap trading on is not covered; turn it off and on again to include it.

## What it can and cannot do

The session key signs **market orders, cash-outs and closes** within those limits while the session has more than 30 seconds left. It is not used for limit orders, stop orders, cancellations, deposits or withdrawals; those always go to your wallet.

If a trade or close is beyond the session's limits, for example a close bigger than 2,500 USDC or one after the 10,000 USDC total is used up, the app asks your wallet to sign it instead. Closing never depends on the one-tap allowance.

The limits are checked by the clearing contract on every trade, not just by the app. A session key cannot:

- trade outside its markets, size limits, fee limit or expiry;
- withdraw collateral, or send it anywhere;
- cancel orders, close positions through the paused-trading path, or grant or revoke sessions;
- be used by a different account.

So the worst a stolen session key can do is trade your account, within those limits, until it expires or you turn it off. That can still lose money, but it cannot take your collateral.

## Where the key lives

The session's private key is held only in the memory of the browser tab that created it. It is never sent to the venue and never written to disk. The tab remembers the session's public address so that it can show you the session and let you turn it off.

That means **reloading the tab or opening another one loses the key**. The grant itself is still valid on chain until it expires. The One-tap trading row then reads "Paused" and offers **Turn on again** and **Revoke**. Turning it on again creates a new key; the old grant stays valid until it expires unless you revoke it, but with its key gone nothing can sign with it.

**Disconnecting** your wallet also drops the key from the tab, so a shared computer keeps nothing that can sign for you. Reconnect and turn it on again to carry on.

## Turning it off

Click **Turn off** in the One-tap trading row (**Revoke** when the row is paused). This is a transaction from your own wallet to the clearing contract, so it costs a little gas; it is not sponsored. Once it confirms, the session key can no longer trade.

You do not need to turn off a session that has simply expired. You can also revoke any session address from the [exit page](../protocol/safety-and-exits.md).

## For integrators

The contract supports sessions of up to 30 days, with any set of markets and limits you choose. The fixed values above are only what the app requests. See [Signing](../integrate/signing.md#sessiongrant) for the grant's fields and the rules the contract applies.
