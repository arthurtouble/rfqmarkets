# RFQ Markets TypeScript SDK

`RfqClient` wraps the public API for scripts and bots. It covers quotes and the quote ladder, market trades,
partial and full closes, resting limit orders, stop-loss / take-profit / stop entries, withdrawals, isolated
margin, account and portfolio reads, candles, and the market stream. Every write uses the API's two-step flow:
the API prepares EIP-712 typed data, your signer signs it, and the API submits the transaction (gas is
sponsored). The client never holds keys.

```ts
import { Wallet } from "ethers";
import { RfqClient } from "./packages/sdk/src/client.js";

const client = new RfqClient({ baseUrl: "https://dev.rfq-markets.workers.dev", signer: new Wallet(process.env.KEY!) });

await client.ladder("BTC", ["100", "1000"]);
await client.trade({ market: "BTC", side: "buy", amount: "25" });
await client.tpsl({ market: "BTC", takeProfitPrice: "130000", stopLossPrice: "110000" });

// Isolated margin: move collateral in, then trade the isolated account (the same wallet signs).
await client.moveIsolatedMargin({ market: "ETH", direction: "add", amount: "20" });
await client.trade({ market: "ETH", side: "sell", amount: "20", account: await client.isolatedAccount(1) });

const stop = client.streamMarkets(({ event, data }) => console.log(event, data));
stop(); // closes the stream
```

Use a session key as the signer to trade without wallet prompts: grant it once with `/v1/session` (scoped to
markets, notional and fees), then sign with the session key. Errors from the API throw `RfqApiError` with the
API's status and body.

Tests: `packages/sdk/src/client.test.ts` runs the client against an in-process API and three approvers.
