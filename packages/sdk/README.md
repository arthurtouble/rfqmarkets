# RFQ Markets TypeScript SDK

`RfqClient` wraps the public API for scripts and bots. It covers quotes and the quote ladder, market trades,
partial and full closes, resting limit orders, stop-loss / take-profit / stop entries, withdrawals, isolated
margin, account and portfolio reads, candles, and the market stream. Every write uses the API's two-step flow:
the API prepares EIP-712 typed data, your signer signs it, and the API submits the transaction (gas is
sponsored). The client never holds keys.

```ts
import { Wallet } from "ethers";
import { RfqClient } from "./packages/sdk/src/client.js";

const client = new RfqClient({
  baseUrl: "https://dev.rfq-markets.workers.dev",
  signer: new Wallet(process.env.KEY!),
  // Recommended: pin the settlement every signature is bound to (see "What gets signed" below).
  chainId: 84532n,
  clearingAddress: "0x…",
});

await client.ladder("BTC", ["100", "1000"]);
await client.trade({ market: "BTC", side: "buy", amount: "25" });
await client.tpsl({ market: "BTC", takeProfitPrice: "130000", stopLossPrice: "110000" });

// Isolated margin: move collateral in, then trade the isolated account (the same wallet signs).
await client.moveIsolatedMargin({ market: "ETH", direction: "add", amount: "20" });
await client.trade({ market: "ETH", side: "sell", amount: "20", account: await client.isolatedAccount(1) });

const stop = client.streamMarkets(({ event, data }) => console.log(event, data));
stop(); // closes the stream
```

## What gets signed

The client does not sign whatever the API prepares. Before every signature it rebuilds the EIP-712 domain
from the pinned `chainId` and `clearingAddress`, uses the protocol's own bundled types, and checks the message
against the request: the account, market, side, size (against the quote and the amount asked for), a limit
price within the requested slippage, the fee cap, a withdrawal's recipient and amount, a margin move's amount
and a session grant's limits. A mismatch throws `IntentMismatchError` and nothing is signed. Without pins the
client reads the chain and contract from the API's `/v1/config` once, which trusts the API to name them; pin
both whenever you know them.

Responses are typed with the shared wire types in `packages/shared/src/api-types.ts` (`Quote`, `TradeResult`,
`AccountState`, `RestingOrder` and the rest, re-exported from the client).

### Sessions

A session key is the safe way to hand a bot or an AI agent a budget. The owner grants it once; the clearing
contract enforces its markets, per-trade and total caps and expiry, and the key can never withdraw, cancel or
grant. The client checks every field of the grant the API prepares before the owner signs it.

```ts
const session = Wallet.createRandom();
await client.grantSession({
  session: session.address,
  marketIndexes: [0, 1], // market indexes from config().marketList
  maxTradeAmount: "100",
  maxCumulativeAmount: "1000",
  durationSeconds: 86_400,
});
const bot = new RfqClient({ baseUrl, signer: session });
await bot.trade({ market: "BTC", side: "buy", amount: "25", account: ownerAddress });
```

A session key can also move isolated margin, adding at most its per-trade cap at a time, so a bot can keep each
position isolated without prompts: pass the owner as `account` to `moveIsolatedMargin`. Revoke a session early,
without gas, with `client.revokeSession(session)`.

### Errors

Errors from the API throw `RfqApiError` with the API's `status` and `body`, plus the stable `code` (for example
`quote_expired`, `insufficient_margin` or `session_limit`) and `retryable`, which says whether the same call can
succeed if made again shortly. Branch on `code`, not the message. The codes are listed in
`packages/shared/src/api-errors.ts` and in the API's OpenAPI document at `/v1/openapi.json`.

## Advanced orders

`strategies.ts` builds three advanced order types from the venue's primitives. They run in your process, and
the planners are pure functions you can use for previews.

```ts
import { placeScaleOrder, runTwap, runTrailingStop, planScale } from "./packages/sdk/src/strategies.js";

// Scale: 1,000 USDC of bids from 100,000 down to 98,000 in 5 limit orders, the deepest 2x the first.
planScale({ totalAmount: "1000", fromPrice: "100000", toPrice: "98000", count: 5, skew: 2 });
await placeScaleOrder(client, {
  market: "BTC",
  side: "buy",
  totalAmount: "1000",
  fromPrice: "100000",
  toPrice: "98000",
  count: 5,
  skew: 2,
});

// TWAP: 5,000 USDC sold as 10 market orders one minute apart (stops at the first failed slice by default).
await runTwap(client, { market: "ETH", side: "sell", totalAmount: "5000", slices: 10, intervalMs: 60_000 });

// Trailing stop: an on-chain stop-loss kept 2% behind the best mid seen.
const trailing = runTrailingStop(client, { market: "BTC", position: "long", trailBps: 200 });
trailing.stop(); // stops trailing; the last stop-loss stays on chain
```

The trailing stop places each new stop before cancelling the old one, and stop-losses are reduce-only, so the
position is never unprotected and a double fill cannot open a new position. Only the trailing needs the
process running; the stop on chain keeps protecting the position if it stops.

Tests: `packages/sdk/src/client.test.ts` runs the client against an in-process API and three approvers;
`strategies.test.ts` covers the advanced order planners and runners.
