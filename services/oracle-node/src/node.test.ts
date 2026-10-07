import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { Wallet } from "ethers";
import { readSseEvents } from "../../../packages/shared/src/sse-events.js";
import {
  SignedOracleClient,
  decodeSignedReport,
  priceBatchFromWire,
  recoverBatchSigner,
} from "../../../packages/shared/src/signed-oracle.js";
import { MemoryCandleStore } from "./candles.js";
import { ADAPTERS } from "./exchanges/index.js";
import { ExchangeFeed } from "./feed.js";
import { StaticMarketSource } from "./markets.js";
import { OracleNode } from "./node.js";
import { buildOracleServer } from "./server.js";
import type { ExchangeName } from "./symbols.js";

const KEYS = [
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
];
const domain = { chainId: 8453n, verifyingContract: "0x000000000000000000000000000000000000dEaD" };

/** Venue messages in each adapter's wire format, so quotes flow through the real parsers. */
const message: Record<string, (ticker: string, bid: string, ask: string) => string> = {
  kraken: (symbol, bid, ask) =>
    JSON.stringify({
      channel: "ticker",
      type: "update",
      data: [{ symbol, bid: Number(bid), ask: Number(ask) }],
    }),
  coinbase: (product_id, best_bid, best_ask) =>
    JSON.stringify({
      channel: "ticker",
      events: [{ type: "update", tickers: [{ product_id, best_bid, best_ask }] }],
    }),
  bitstamp: (pair, bid, ask) =>
    JSON.stringify({
      event: "data",
      channel: `order_book_${pair}`,
      data: { bids: [[bid, "1"]], asks: [[ask, "1"]] },
    }),
  okx: (instId, bid, ask) =>
    JSON.stringify({
      arg: { channel: "bbo-tbt", instId },
      data: [{ bids: [[bid, "1", "0", "1"]], asks: [[ask, "1", "0", "1"]] }],
    }),
};

function harness(key = KEYS[0], btcOffset = 0) {
  const clock = { now: 1_700_000_000_250 },
    feeds = new Map<ExchangeName, ExchangeFeed>(),
    candles = new MemoryCandleStore();
  const node = new OracleNode({
    signer: new Wallet(key),
    domain,
    marketSource: new StaticMarketSource([
      { id: 0, symbol: "BTC" },
      { id: 1, symbol: "ETH" },
    ]),
    candles,
    exchanges: ["kraken", "coinbase", "bitstamp", "okx"],
    now: () => clock.now,
    feedFactory: (exchange, tickers) => {
      const feed = new ExchangeFeed(ADAPTERS[exchange], tickers, { now: () => clock.now });
      feeds.set(exchange, feed);
      return feed;
    },
  });
  const push = (exchange: ExchangeName, ticker: string, bid: string, ask: string) =>
    feeds.get(exchange)!.handleMessage(message[exchange](ticker, bid, ask));
  const quoteAll = () => {
    const btc = (value: number) => String(value + btcOffset);
    push("kraken", "USDT/USD", "0.9995", "0.9997");
    push("coinbase", "USDT-USD", "0.9995", "0.9997");
    push("kraken", "BTC/USD", btc(84_000), btc(84_000.2));
    push("coinbase", "BTC-USD", btc(84_010), btc(84_010.2));
    push("bitstamp", "btcusd", btc(84_005), btc(84_005.2));
    push("okx", "BTC-USDT", btc(84_050), btc(84_050.2)); // x 0.9996 USDT/USD
    // ETH only on two venues: below the three-source minimum.
    push("kraken", "ETH/USD", "2600", "2600.1");
    push("coinbase", "ETH-USD", "2600", "2600.1");
  };
  return { node, clock, feeds, candles, push, quoteAll };
}

test("a tick signs the markets that pass and omits the rest", async () => {
  const { node, clock, quoteAll, candles } = harness();
  await node.refreshMarkets();
  assert.equal(await node.tick(), undefined, "no quotes yet");
  quoteAll();
  const record = (await node.tick())!;
  assert.equal(record.batch.observedAt, 1_700_000_000);
  assert.deepEqual(
    record.batch.prices.map((price) => price.market),
    [0],
  );
  const [btc] = record.batch.prices;
  // USDT/USD = 0.9996, so OKX's mid is 84016.47996. Mids 84000.1, 84005.1, 84010.1, 84016.47996:
  // median 84007.6, half-spread 8.87996 -> 83998.72004 / 84016.47996.
  assert.equal(btc.bid, 83_998_720_040n);
  assert.equal(btc.ask, 84_016_479_960n);
  assert.equal(recoverBatchSigner(domain, record.batch), new Wallet(KEYS[0]).address);
  assert.deepEqual(record.wire.prices[0], {
    market: 0,
    symbol: "BTC",
    bid: btc.bid.toString(),
    ask: btc.ask.toString(),
    sources: 4,
  });
  assert.deepEqual(priceBatchFromWire(record.wire), record.batch);
  const eth = record.outcomes.find((outcome) => outcome.market === 1)!;
  assert.equal(eth.included, false);
  assert.equal(eth.reason, "insufficient-sources");
  assert.equal(await node.tick(), undefined, "one batch per second");
  clock.now += 1_000;
  quoteAll();
  assert.equal((await node.tick())!.batch.observedAt, 1_700_000_001);
  assert.equal(candles.range(0, 0, clock.now)[0].samples, 2);
  // Every source goes stale -> nothing to sign.
  clock.now += 3_000;
  assert.equal(await node.tick(), undefined);
  const health = node.health();
  assert.equal(health.ok, false);
  assert.equal(health.markets[0].reason, "insufficient-sources");
  assert.equal(JSON.stringify(health).includes(KEYS[0].slice(2)), false, "the key never appears in health");
  await node.close();
});

test("USDT venues drop out when the USDT rate is unavailable", async () => {
  const { node, push } = harness();
  await node.refreshMarkets();
  push("kraken", "BTC/USD", "84000", "84000.2");
  push("coinbase", "BTC-USD", "84010", "84010.2");
  push("okx", "BTC-USDT", "84050", "84050.2");
  push("kraken", "USDT/USD", "0.9995", "0.9997"); // one stable source; two are required
  assert.equal(await node.tick(), undefined);
  assert.deepEqual(node.health().markets[0].sourceNames, ["kraken", "coinbase"]);
  await node.close();
});

async function serve(node: OracleNode, candles: MemoryCandleStore) {
  const app = buildOracleServer({ node, candles, heartbeatMs: 60_000, now: () => 1_700_000_001_000 });
  await app.listen({ host: "127.0.0.1", port: 0 });
  return { app, url: `http://127.0.0.1:${(app.server.address() as AddressInfo).port}` };
}

test("HTTP API: health, latest batch, SSE stream and candles", async () => {
  const { node, clock, quoteAll, candles } = harness();
  await node.refreshMarkets();
  const { app, url } = await serve(node, candles);
  try {
    assert.equal((await fetch(`${url}/v1/batch/latest`)).status, 503);
    assert.equal((await fetch(`${url}/health`)).status, 503);
    quoteAll();
    await node.tick();
    const latest = await (await fetch(`${url}/v1/batch/latest`)).json();
    assert.equal(latest.observedAt, 1_700_000_000);
    assert.equal(latest.signer, new Wallet(KEYS[0]).address);
    assert.equal(latest.chainId, "8453");
    const health = await fetch(`${url}/health`);
    assert.equal(health.status, 200);
    const body = await health.json();
    assert.equal(body.markets[0].sources, 4);
    assert.equal(body.stableRates.USDT, "0.9996");

    const abort = new AbortController(),
      stream = await fetch(`${url}/v1/batch/stream`, { signal: abort.signal });
    assert.equal(stream.headers.get("content-type"), "text/event-stream");
    const events = readSseEvents(stream.body!);
    const first = (await events.next()).value!;
    assert.equal(first.event, "batch");
    assert.equal(JSON.parse(first.data).observedAt, 1_700_000_000, "the latest batch is replayed on connect");
    clock.now += 1_000;
    quoteAll();
    await node.tick();
    const second = (await events.next()).value!;
    assert.equal(JSON.parse(second.data).observedAt, 1_700_000_001);
    assert.equal(second.id, "1700000001");
    abort.abort();
    await events.return(undefined);

    const candleBody = await (
      await fetch(`${url}/v1/candles?market=0&interval=1m&from=1699999900&to=1700000100`)
    ).json();
    assert.equal(candleBody.symbol, "BTC");
    assert.equal(candleBody.candles.length, 1);
    assert.equal(candleBody.candles[0].time, 1_699_999_980);
    assert.equal(candleBody.candles[0].samples, 2);
    assert.equal((await (await fetch(`${url}/v1/candles?market=0&interval=5m`)).json()).candles.length, 1);
    assert.equal((await fetch(`${url}/v1/candles?market=x`)).status, 400);
    assert.equal((await fetch(`${url}/v1/candles?market=0&interval=2m`)).status, 400);
    assert.equal((await fetch(`${url}/v1/candles?market=0&from=20&to=10`)).status, 400);

    const page = await (await fetch(`${url}/v1/batches?after=0&limit=1`)).json();
    assert.deepEqual(
      page.batches.map((batch: { observedAt: number }) => batch.observedAt),
      [1_700_000_000],
    );
    assert.equal(page.more, true);
    assert.equal(page.oldest, 1_700_000_000);
    assert.deepEqual(priceBatchFromWire(page.batches[0]), priceBatchFromWire(latest));
    const rest = await (await fetch(`${url}/v1/batches?after=1700000000`)).json();
    assert.deepEqual(
      rest.batches.map((batch: { observedAt: number; signer: string }) => [batch.observedAt, batch.signer]),
      [[1_700_000_001, new Wallet(KEYS[0]).address]],
    );
    assert.equal(rest.more, false);
    assert.equal((await fetch(`${url}/v1/batches?after=-1`)).status, 400);
    assert.equal((await fetch(`${url}/v1/batches?limit=5000`)).status, 400);
  } finally {
    await app.close();
    await node.close();
  }
});

test("three nodes feed a SignedOracleClient that builds a 3-of-3 report", async () => {
  const nodes = KEYS.map((key, index) => harness(key, index * 2));
  const servers = [];
  for (const { node, quoteAll, candles } of nodes) {
    await node.refreshMarkets();
    quoteAll();
    await node.tick();
    servers.push(await serve(node, candles));
  }
  const client = new SignedOracleClient({
    domain,
    nodes: servers.map((server) => server.url),
    signers: KEYS.map((key) => new Wallet(key).address),
    threshold: 2,
    maxDeviationBps: 50,
    maxSkewSeconds: 3,
    now: () => 1_700_000_001_000,
  });
  try {
    await client.start();
    const latest = client.latest()!;
    assert.equal(latest.signers.length, 3);
    assert.equal(latest.validUntil, 1_700_000_015);
    assert.deepEqual(
      latest.prices.map((price) => price.market),
      [0],
    );
    const middle = nodes[1].node.latest()!.batch.prices[0];
    assert.equal(latest.prices[0].bid, middle.bid, "median of three = the middle node");
    assert.equal(latest.prices[0].ask, middle.ask);
    assert.equal(decodeSignedReport(latest.report).length, 3);
  } finally {
    await client.close();
    for (const server of servers) await server.app.close();
    for (const { node } of nodes) await node.close();
  }
});
