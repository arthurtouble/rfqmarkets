# Connecting to trade

Every trade fills with one tap, with no wallet prompt. Before your first trade in a browser, the app sets up a connection: you sign once in your wallet, and after that trades, cash-outs, closes and TP/SL go straight through.

## Connecting

Connect your wallet, then tap **Start trading** on Home or the Pro ticket. The app generates a fresh trading key in your browser and your wallet asks you to sign a *SessionGrant*. The venue submits the grant on chain and pays the gas. When it confirms, the app shows "Connection established. You can start trading." and the trade buttons appear.

The connection lasts a week. When it runs out, **Start trading** comes back and one more signature connects you again. A market listed after you connected is covered the next time you connect; your first trade in it asks your wallet to connect again.

## Limits

The trading key has no trading limit of its own: it can sign any trade the venue would accept from your wallet. The limits that apply are the markets' own, the same for every trade however it is signed:

| Limit | Value |
| --- | --- |
| Markets | Every market listed when you connect |
| Largest single trade | The market's per-trade cap, shown on the ticket. Closes and cash-outs are never held back by it |
| Total traded | No limit |
| Highest fee on any one trade | 0.1% (10 bps) of 5,000,000 USDC, far above the 0.04% trading fee |
| Duration | 7 days |

## What it can and cannot do

The trading key signs **market, limit and stop orders, TP/SL, cash-outs and closes** while it has more than 30 seconds left. Deposits, withdrawals and order cancellations always go to your wallet.

The contract checks the key on every trade, not just the app. A trading key cannot:

- trade outside its markets or after it expires;
- withdraw collateral, or send it anywhere outside your own accounts;
- cancel orders, grant or revoke keys, or change who controls the account;
- be used by a different account.

So the worst a stolen trading key can do is trade your account until it expires or you revoke it. That can lose money, but it cannot take your collateral.

## Where the key lives

The key is kept in this browser's storage, so trading survives a reload. It is never sent to the venue. Only the newest key you granted signs trades: connecting in another browser retires the key in the first one.

**Disconnecting** your wallet deletes the key from the browser, so a shared computer keeps nothing that can sign for you. Reconnect and tap **Start trading** to carry on.

If you think a key has been copied, revoke it from the [exit page](../protocol/safety-and-exits.md). You do not need to revoke a key that has simply expired.

## For integrators

The contract supports sessions of up to 30 days, with any set of markets and limits you choose. The values above are only what the app requests. See [Signing](../integrate/signing.md#sessiongrant) for the grant's fields and the rules the contract applies.
