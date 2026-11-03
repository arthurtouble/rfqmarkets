// The trader's journey, end to end against a running stack: every action the trade screen offers, through the real
// API, approvers, oracle and contracts, with waits that let stored on-chain prices go stale between steps (the
// condition dev and mainnet live in, and the one the browser tests never reached).
//
//   Local production parity:  npm run dev:stack -- --parity   then   npm run journey
//   Dev after a deploy:       RFQ_API_URL=https://dev.rfq-markets.workers.dev RFQ_JOURNEY_KEY_FILE=qa-wallet.json \
//                             RFQ_QA_PASS=... RFQ_JOURNEY_NOTIONAL=5 npm run journey
//
// Env: RFQ_API_URL (default http://127.0.0.1:4100), RFQ_JOURNEY_KEY or RFQ_JOURNEY_KEY_FILE (JSON with privateKey;
// default the local dev wallet), RFQ_QA_PASS (dev geofence pass), RFQ_JOURNEY_NOTIONAL (USDC per opening trade,
// default 50), RFQ_JOURNEY_STALE_SECONDS (wait that ages stored prices past the contract's 15 s, default 20),
// RFQ_PRICE_CONTROL_URL (local simulated prices; enables the triggered-fill step), RFQ_JOURNEY_MARKETS (two
// comma-separated markets, default BTC,ETH). Exits non-zero on the first failure, naming the step and the API's answer.
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { Wallet } from "ethers";
import { RfqApiError, RfqClient } from "../../packages/sdk/src/client.js";

const api = process.env.RFQ_API_URL ?? "http://127.0.0.1:4100";
const notional = Number(process.env.RFQ_JOURNEY_NOTIONAL ?? "50");
const staleSeconds = Number(process.env.RFQ_JOURNEY_STALE_SECONDS ?? "20");
const priceControl = process.env.RFQ_PRICE_CONTROL_URL;
const [first, second] = (process.env.RFQ_JOURNEY_MARKETS ?? "BTC,ETH").split(",").map((item) => item.trim());
const qaPass = process.env.RFQ_QA_PASS?.trim();

function loadKey() {
  if (process.env.RFQ_JOURNEY_KEY) return process.env.RFQ_JOURNEY_KEY;
  const file = process.env.RFQ_JOURNEY_KEY_FILE;
  if (file) return (JSON.parse(readFileSync(file, "utf8")) as { privateKey: string }).privateKey;
  const local = resolve(".local-state", "deployment.json");
  if (existsSync(local))
    return (JSON.parse(readFileSync(local, "utf8")) as { devWallet: { privateKey: string } }).devWallet
      .privateKey;
  throw new Error("no wallet: set RFQ_JOURNEY_KEY or RFQ_JOURNEY_KEY_FILE");
}

const wallet = new Wallet(loadKey());
const withPass: typeof fetch = (input, init = {}) =>
  fetch(
    input,
    qaPass
      ? { ...init, headers: { ...(init.headers as Record<string, string>), "x-rfq-qa-pass": qaPass } }
      : init,
  );
const client = new RfqClient({ baseUrl: api, signer: wallet, fetch: withPass, timeoutMs: 60_000 });

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
const amount = (scale = 1) => (notional * scale).toFixed(2);
const results: Array<{ step: string; ms: number; detail?: string }> = [];

async function step<T>(name: string, run: () => Promise<T>, detail?: (value: T) => string): Promise<T> {
  const started = Date.now();
  process.stdout.write(`• ${name} ... `);
  try {
    const value = await run();
    const ms = Date.now() - started,
      note = detail?.(value);
    results.push({ step: name, ms, detail: note });
    console.log(`ok (${(ms / 1000).toFixed(1)} s)${note ? ` ${note}` : ""}`);
    return value;
  } catch (error) {
    console.log("FAILED");
    const body = error instanceof RfqApiError ? `\n  API ${error.status}: ${JSON.stringify(error.body)}` : "";
    console.error(`\nTrade journey failed at "${name}" against ${api}: ${(error as Error).message}${body}`);
    console.error(`Passed before it: ${results.map((item) => item.step).join(" → ") || "nothing"}`);
    process.exit(1);
  }
}

/** Waits past the contract's stored-price age (15 s) with nothing refreshing prices, as an idle trader would. */
async function letPricesGoStale(reason: string) {
  await step(`wait ${staleSeconds} s (${reason})`, () => sleep(staleSeconds * 1_000));
}

async function size(market: string, account = wallet.address) {
  const state = await client.account(account);
  return BigInt(state.positions[market as keyof typeof state.positions]?.size ?? "0");
}

function expect(condition: boolean, message: string) {
  if (!condition) throw new Error(message);
}

async function waitFor(what: string, check: () => Promise<boolean>, timeoutMs = 45_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await sleep(1_000);
  }
  throw new Error(`timed out waiting for ${what}`);
}

const marketIndex = async (market: string) => {
  const markets = (await client.request<{ markets: Record<string, { index: number }> }>("/v1/markets"))
    .markets;
  const index = markets[market]?.index;
  if (index === undefined) throw new Error(`market ${market} is not listed`);
  return index;
};

console.log(`Trade journey: ${wallet.address} on ${api}, ${notional} USDC trades, ${first} and ${second}\n`);

// Start flat so every assertion below is about this run.
await step("start flat (close anything left open)", async () => {
  const state = await client.account();
  expect(
    BigInt(state.collateral) >= BigInt(Math.ceil(notional * 4 * 1e6)),
    `collateral ${state.collateral} is too low`,
  );
  if (Object.values(state.positions).some((position) => BigInt(position.size) !== 0n))
    await client.closeAll();
  for (const market of [first, second]) expect((await size(market)) === 0n, `${market} still open`);
});

await step(
  `open long ${first}`,
  () => client.trade({ market: first, side: "buy", amount: amount() }),
  (r) => r.transaction.hash,
);
await step(`open short ${second} (cross: gross risk in two markets)`, () =>
  client.trade({ market: second, side: "sell", amount: amount() }),
);
await letPricesGoStale("stored prices of both markets age out");
await step(`add to ${first} with ${second}'s stored price stale`, () =>
  client.trade({ market: first, side: "buy", amount: amount(0.5) }),
);
await letPricesGoStale("again before a reduction");
await step(`partial close ${first} (50%)`, async () => {
  const before = await size(first);
  await client.close({ market: first, fraction: 5_000 });
  const after = await size(first);
  expect(after > 0n && after < before, `size ${before} -> ${after}`);
});

const orders = await step(`set TP/SL on ${first}`, async () => {
  const mid =
    Number(
      (await client.request<{ markets: Record<string, { mid: string }> }>("/v1/markets")).markets[first].mid,
    ) / 1e6;
  return client.tpsl({
    market: first,
    takeProfitPrice: (mid * 1.5).toFixed(2),
    stopLossPrice: (mid * 0.5).toFixed(2),
  });
});
await step("TP/SL listed as open orders", async () => {
  const { items } = await client.orders();
  const ids = new Set(items.filter((order) => order.status === "open").map((order) => order.orderId));
  for (const order of orders) expect(ids.has(order.orderId), `order ${order.orderId} not open`);
});
await step("cancel TP/SL", () => client.cancelOrder(orders[0].orderId));

if (priceControl) {
  // Local only: move the simulated price through a stop and watch the API fill it on chain. The move stays inside
  // the stop's 1% slippage band; a gap past it rests the order until the price comes back (by design).
  const stopped = await step(`stop-loss on ${second} fills when the price crosses`, async () => {
    const before = await size(second);
    const prices = (await (await fetch(`${priceControl}/price`)).json()) as Record<string, number>;
    const mid = prices[second];
    await client.triggerOrder({
      market: second,
      kind: "stop-loss",
      triggerPrice: (mid * 1.01).toFixed(2),
      sizing: "position",
    });
    await letPricesGoStale("the stop rests while prices age");
    await fetch(`${priceControl}/price`, {
      method: "POST",
      body: JSON.stringify({ market: second, price: mid * 1.014 }),
    });
    await waitFor("the stop-loss to close the position", async () => (await size(second)) === 0n, 60_000);
    await fetch(`${priceControl}/price`, {
      method: "POST",
      body: JSON.stringify({ market: second, price: mid }),
    });
    return before;
  });
  void stopped;
  await step(`reopen short ${second}`, () =>
    client.trade({ market: second, side: "sell", amount: amount() }),
  );
}

await letPricesGoStale("before closing one market of two");
await step(`close ${second} fully`, async () => {
  await client.close({ market: second });
  expect((await size(second)) === 0n, `${second} still open`);
});

// Isolated margin: margin moves carry no oracle report, so they depend on the API refreshing stored prices.
const index = await marketIndex(second);
const isolated = await client.isolatedAccount(index);
await step(`move margin into isolated ${second}`, () =>
  client.moveIsolatedMargin({ market: second, direction: "add", amount: amount() }),
);
await step(`open isolated long ${second}`, () =>
  client.trade({ market: second, side: "buy", amount: amount(), account: isolated }),
);
await letPricesGoStale("isolated position idle");
await step(`add isolated margin with stale prices`, () =>
  client.moveIsolatedMargin({ market: second, direction: "add", amount: amount(0.2) }),
);
await step(`close isolated ${second}`, async () => {
  await client.close({ market: second, account: isolated });
  expect((await size(second, isolated)) === 0n, "isolated position still open");
});
await step("withdraw isolated margin back", async () => {
  const left = BigInt((await client.account(isolated)).collateral);
  if (left > 0n)
    await client.moveIsolatedMargin({
      market: second,
      direction: "remove",
      amount: (Number(left) / 1e6).toFixed(6),
    });
});

await letPricesGoStale("before a withdrawal with a position open");
await step("withdraw 1 USDC with a cross position open", () => client.withdraw({ amount: "1" }));

await step(`reopen ${second} short (two cross positions again)`, () =>
  client.trade({ market: second, side: "sell", amount: amount() }),
);
await letPricesGoStale("before close all");
await step("close all", async () => {
  await client.closeAll();
  for (const market of [first, second])
    expect((await size(market)) === 0n, `${market} still open after close all`);
});

const total = results.reduce((sum, item) => sum + item.ms, 0);
console.log(
  `\nTrade journey passed: ${results.length} steps in ${(total / 1000).toFixed(0)} s against ${api}`,
);
