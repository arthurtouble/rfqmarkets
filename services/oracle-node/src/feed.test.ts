import assert from "node:assert/strict";
import { test } from "node:test";
import { parseDecimal } from "./decimal.js";
import { ADAPTERS } from "./exchanges/index.js";
import { ExchangeFeed, type SocketLike } from "./feed.js";

class FakeSocket implements SocketLike {
  readyState = 0;
  sent: string[] = [];
  private listeners = new Map<string, Array<(event: any) => void>>();
  constructor(readonly url: string) {}
  addEventListener(type: string, listener: (event: any) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  emit(type: string, event: unknown = {}) {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
  open() {
    this.readyState = 1;
    this.emit("open");
  }
  message(data: string) {
    this.emit("message", { data });
  }
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.readyState = 3;
    this.emit("close");
  }
}

function harness(exchange: keyof typeof ADAPTERS, tickers: string[], fetchImpl?: typeof fetch) {
  const clock = { now: 10_000 },
    sockets: FakeSocket[] = [];
  const feed = new ExchangeFeed(ADAPTERS[exchange], tickers, {
    now: () => clock.now,
    socketFactory: (url) => {
      const socket = new FakeSocket(url);
      sockets.push(socket);
      return socket;
    },
    fetchImpl,
    reconnectMs: 1,
  });
  return { feed, clock, sockets };
}
const binanceMessage = (symbol: string, bid: string, ask: string) =>
  JSON.stringify({ stream: `${symbol.toLowerCase()}@bookTicker`, data: { s: symbol, b: bid, a: ask } });

test("a bbo-complete stream keeps quiet books current while the connection talks", () => {
  const { feed, clock, sockets } = harness("binance", ["BTCUSDT", "PEPEUSDT"]);
  feed.start();
  sockets[0].open();
  sockets[0].message(binanceMessage("PEPEUSDT", "0.000004", "0.0000041"));
  clock.now += 5_000;
  sockets[0].message(binanceMessage("BTCUSDT", "84000", "84000.01"));
  const pepe = feed.quote("PEPEUSDT")!;
  assert.equal(pepe.receivedAtMs, 10_000);
  assert.equal(pepe.asOfMs, 15_000, "confirmed by later traffic on the same connection");
  assert.equal(feed.quote("BTCUSDT")!.bid, parseDecimal("84000"));
  // After the connection drops, quotes age by their receive time.
  sockets[0].close();
  assert.equal(feed.quote("PEPEUSDT")!.asOfMs, 10_000);
  assert.equal(feed.connected, false);
  feed.close();
});

test("quotes from a previous connection are not confirmed by a new one", async () => {
  const { feed, clock, sockets } = harness("binance", ["BTCUSDT", "PEPEUSDT"]);
  feed.start();
  sockets[0].open();
  sockets[0].message(binanceMessage("PEPEUSDT", "0.000004", "0.0000041"));
  sockets[0].close();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(sockets.length, 2, "reconnected");
  sockets[1].open();
  clock.now += 3_000;
  sockets[1].message(binanceMessage("BTCUSDT", "84000", "84000.01"));
  assert.equal(feed.quote("PEPEUSDT")!.asOfMs, 10_000);
  assert.equal(feed.quote("BTCUSDT")!.asOfMs, 13_000);
  feed.close();
});

test("a trade-driven stream ages quotes by receive time; pings go out on bbo venues", async () => {
  const coinbase = harness("coinbase", ["BTC-USD", "ETH-USD"]);
  coinbase.feed.start();
  coinbase.sockets[0].open();
  assert.equal(JSON.parse(coinbase.sockets[0].sent[0]).product_ids.length, 2);
  coinbase.sockets[0].message(
    JSON.stringify({
      channel: "ticker",
      events: [{ tickers: [{ product_id: "ETH-USD", best_bid: "2600", best_ask: "2600.01" }] }],
    }),
  );
  coinbase.clock.now += 4_000;
  coinbase.sockets[0].message(JSON.stringify({ channel: "heartbeats", events: [] }));
  assert.equal(coinbase.feed.quote("ETH-USD")!.asOfMs, 10_000);
  coinbase.feed.close();

  const okx = harness("okx", ["BTC-USDT"], (async () => Response.json({ data: [] })) as typeof fetch);
  okx.feed.start();
  okx.sockets[0].open();
  await okx.feed.maintain();
  assert.equal(okx.sockets[0].sent.at(-1), "ping");
  okx.feed.close();
});

test("a silent connection is recycled", async () => {
  const { feed, clock, sockets } = harness("kraken", ["BTC/USD"], (async () =>
    Response.json({})) as typeof fetch);
  feed.start();
  sockets[0].open();
  clock.now += 11_000;
  await feed.maintain();
  assert.equal(sockets[0].readyState, 3);
  assert.equal(sockets.length, 2);
  feed.close();
});

test("REST fallback refreshes stale tickers and backs off after failures", async () => {
  const calls: string[] = [];
  let fail = false;
  const fetchImpl = (async (url: string | URL) => {
    calls.push(String(url));
    if (fail) return new Response("blocked", { status: 403 });
    return Response.json({ result: { "BTC/USD": { b: ["84000.1", "1", "1"], a: ["84000.2", "1", "1"] } } });
  }) as typeof fetch;
  const { feed, clock } = harness("kraken", ["BTC/USD", "ETH/USD"], fetchImpl);
  await feed.pollRest();
  assert.equal(calls.length, 1, "one batched request");
  const btc = feed.quote("BTC/USD")!;
  assert.equal(btc.transport, "rest");
  assert.equal(btc.bid, parseDecimal("84000.1"));
  assert.equal(feed.quote("ETH/USD"), undefined);
  fail = true;
  clock.now += 2_000;
  await feed.pollRest();
  assert.equal(calls.length, 2);
  await feed.pollRest();
  assert.equal(calls.length, 2, "backing off after a failure");
  clock.now += 2_001;
  await feed.pollRest();
  assert.equal(calls.length, 3);
  assert.equal(feed.status().restFailures, 2);
});

test("per-ticker REST venues cap the requests per poll", async () => {
  const calls: string[] = [];
  const fetchImpl = (async (url: string | URL) => {
    calls.push(String(url));
    return Response.json({ bid: "1", ask: "1.01" });
  }) as typeof fetch;
  const tickers = Array.from({ length: 6 }, (_, i) => `T${i}-USD`);
  const { feed } = harness("coinbase", tickers, fetchImpl);
  await feed.pollRest();
  assert.equal(calls.length, 4);
  await feed.pollRest();
  assert.equal(calls.length, 6, "the oldest tickers are refreshed next");
  assert.equal(feed.status().freshTickers, 6);
});

test("changing tickers reconnects with the new subscription", () => {
  const { feed, sockets } = harness("bybit", ["BTCUSDT"]);
  feed.start();
  sockets[0].open();
  assert.deepEqual(JSON.parse(sockets[0].sent[0]).args, ["orderbook.1.BTCUSDT"]);
  feed.setTickers(["BTCUSDT"]);
  assert.equal(sockets.length, 1, "unchanged tickers keep the connection");
  feed.setTickers(["BTCUSDT", "ETHUSDT"]);
  assert.equal(sockets.length, 2);
  sockets[1].open();
  assert.deepEqual(JSON.parse(sockets[1].sent[0]).args, ["orderbook.1.BTCUSDT", "orderbook.1.ETHUSDT"]);
  feed.close();
});

test("connection liveness vouches for a quote only up to the absolute age cap", () => {
  const { feed, clock, sockets } = harness("binance", ["BTCUSDT", "PEPEUSDT"]);
  feed.start();
  sockets[0].open();
  sockets[0].message(binanceMessage("PEPEUSDT", "0.000004", "0.0000041"));
  clock.now += 29_000;
  sockets[0].message(binanceMessage("BTCUSDT", "84000", "84000.01"));
  assert.equal(feed.quote("PEPEUSDT")!.asOfMs, 39_000, "still within the cap");
  clock.now += 2_000;
  sockets[0].message(binanceMessage("BTCUSDT", "84000", "84000.01"));
  assert.equal(feed.quote("PEPEUSDT")!.asOfMs, 10_000, "a frozen ticker ages by its receive time");
  assert.equal(feed.status().freshTickers, 1);
  feed.close();
});

test("a crossed or one-sided book update drops the stored quote", () => {
  const { feed, sockets } = harness("binance", ["BTCUSDT"]);
  feed.start();
  sockets[0].open();
  sockets[0].message(binanceMessage("BTCUSDT", "84000", "84000.01"));
  assert.ok(feed.quote("BTCUSDT"));
  sockets[0].message(binanceMessage("BTCUSDT", "84001", "84000"));
  assert.equal(feed.quote("BTCUSDT"), undefined, "crossed");
  sockets[0].message(binanceMessage("BTCUSDT", "84000", "84000.01"));
  assert.ok(feed.quote("BTCUSDT"));
  sockets[0].message(binanceMessage("BTCUSDT", "0", "84000.01"));
  assert.equal(feed.quote("BTCUSDT"), undefined, "one-sided");
  feed.close();
});
