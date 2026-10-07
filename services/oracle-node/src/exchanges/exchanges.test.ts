import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { parseDecimal } from "../decimal.js";
import type { ExchangeName } from "../symbols.js";
import { ADAPTERS } from "./index.js";
import type { QuoteUpdate } from "./types.js";

interface Fixture {
  messages: string[];
  rest: unknown;
}
const fixture = (exchange: ExchangeName): Fixture =>
  JSON.parse(readFileSync(new URL(`../../fixtures/${exchange}.json`, import.meta.url), "utf8"));

/** Replays the recorded websocket messages and returns the last quote per ticker. */
function replay(exchange: ExchangeName) {
  const parse = ADAPTERS[exchange].createParser(),
    last = new Map<string, { bid: bigint; ask: bigint }>();
  for (const raw of fixture(exchange).messages)
    for (const update of parse(raw)) last.set(update.ticker, { bid: update.bid, ask: update.ask });
  return last;
}
const p = (text: string) => parseDecimal(text);
const pair = (bid: string, ask: string) => ({ bid: p(bid), ask: p(ask) });
const restQuotes = (
  exchange: ExchangeName,
  tickers: string[],
  body = fixture(exchange).rest,
): QuoteUpdate[] =>
  ADAPTERS[exchange].restRequests(tickers).flatMap((request) => {
    const scoped =
      body &&
      typeof body === "object" &&
      !Array.isArray(body) &&
      request.tickers.length === 1 &&
      (body as any)[request.tickers[0]];
    return request.parse(scoped || body);
  });
const asMap = (updates: QuoteUpdate[]) =>
  new Map(updates.map((update) => [update.ticker, { bid: update.bid, ask: update.ask }]));

// Expected values were read directly from the recorded messages (last top of book per ticker).
test("coinbase ticker messages and REST ticker", () => {
  const last = replay("coinbase");
  assert.deepEqual(last.get("BTC-USD"), pair("84076.5", "84076.51"));
  assert.deepEqual(last.get("ETH-USD"), pair("2614.63", "2614.64"));
  assert.deepEqual(last.get("PEPE-USD"), pair("0.00000414", "0.00000415"));
  assert.deepEqual(last.get("USDT-USD"), pair("0.99959", "0.9996"));
  assert.deepEqual(restQuotes("coinbase", ["BTC-USD"]), [
    { ticker: "BTC-USD", ...pair("84070", "84070.01") },
  ]);
  const subscribe = ADAPTERS.coinbase.subscribeMessages(["BTC-USD", "ETH-USD"]).map((m) => JSON.parse(m));
  assert.deepEqual(subscribe[0], {
    type: "subscribe",
    product_ids: ["BTC-USD", "ETH-USD"],
    channel: "ticker",
  });
  assert.equal(subscribe[1].channel, "heartbeats");
});

test("kraken v2 ticker (JSON numbers) and REST Ticker", () => {
  const last = replay("kraken");
  assert.deepEqual(last.get("BTC/USD"), pair("84074.2", "84074.3"));
  assert.deepEqual(last.get("ETH/USD"), pair("2615", "2615.01"));
  assert.deepEqual(last.get("PEPE/USD"), pair("0.000004143", "0.000004144"));
  assert.deepEqual(last.get("USDT/USD"), pair("0.9996", "0.99961"));
  assert.deepEqual(last.get("USDC/USD"), pair("0.9998", "0.9999"));
  const rest = asMap(restQuotes("kraken", ["BTC/USD", "ETH/USD", "USDT/USD", "XRP/USD"]));
  assert.equal(rest.size, 3, "tickers missing from the response are skipped");
  assert.deepEqual(rest.get("ETH/USD"), pair("2615", "2615.01"));
  const [request] = ADAPTERS.kraken.restRequests(["BTC/USD", "USDT/USD"]);
  assert.equal(request.url, "https://api.kraken.com/0/public/Ticker?pair=BTC%2FUSD,USDT%2FUSD");
  assert.deepEqual(JSON.parse(ADAPTERS.kraken.subscribeMessages(["BTC/USD"])[0]).params, {
    channel: "ticker",
    symbol: ["BTC/USD"],
    event_trigger: "bbo",
    snapshot: true,
  });
});

test("bitstamp order book snapshots and REST ticker list", () => {
  const last = replay("bitstamp");
  assert.deepEqual(last.get("btcusd"), pair("84080.17", "84080.18"));
  assert.deepEqual(last.get("ethusd"), pair("2614.90", "2614.91"));
  assert.deepEqual(last.get("pepeusd"), pair("0.00000414", "0.00000415"));
  assert.deepEqual(last.get("usdtusd"), pair("0.99958", "0.99966"));
  const rest = asMap(restQuotes("bitstamp", ["btcusd", "usdcusd"]));
  assert.deepEqual([...rest.keys()].sort(), ["btcusd", "usdcusd"], "other pairs (BTC/EUR) are ignored");
  assert.ok(rest.get("btcusd")!.bid > p("80000"));
});

test("gemini l2 book reconstruction and REST pubticker", () => {
  const last = replay("gemini");
  assert.deepEqual(last.get("BTCUSD"), pair("84083.19", "84083.2"));
  assert.deepEqual(last.get("ETHUSD"), pair("2614.78", "2614.79"));
  assert.deepEqual(last.get("PEPEUSD"), pair("0.000004142", "0.000004143"));
  assert.deepEqual(last.get("USDTUSD"), pair("0.99955", "0.99956"));
  assert.deepEqual(restQuotes("gemini", ["BTCUSD"]), [{ ticker: "BTCUSD", ...pair("84072.36", "84072.37") }]);
  assert.equal(ADAPTERS.gemini.restRequests(["BTCUSD"])[0].url, "https://api.gemini.com/v1/pubticker/btcusd");
});

test("gemini removes the best level and finds the next one", () => {
  const parse = ADAPTERS.gemini.createParser();
  const message = (changes: string[][], snapshot = false) =>
    JSON.stringify({ type: "l2_updates", symbol: "BTCUSD", changes, ...(snapshot ? { trades: [] } : {}) });
  assert.deepEqual(
    parse(
      message(
        [
          ["buy", "100", "1"],
          ["buy", "99", "1"],
          ["sell", "101", "1"],
          ["sell", "102", "1"],
        ],
        true,
      ),
    ),
    [{ ticker: "BTCUSD", ...pair("100", "101") }],
  );
  assert.deepEqual(parse(message([["buy", "100", "0"]])), [{ ticker: "BTCUSD", ...pair("99", "101") }]);
  assert.deepEqual(parse(message([["sell", "100.5", "2"]])), [{ ticker: "BTCUSD", ...pair("99", "100.5") }]);
  // A fresh snapshot replaces the book.
  assert.deepEqual(
    parse(
      message(
        [
          ["buy", "50", "1"],
          ["sell", "51", "1"],
        ],
        true,
      ),
    ),
    [{ ticker: "BTCUSD", ...pair("50", "51") }],
  );
  assert.deepEqual(
    parse(message([["sell", "51", "0"]])),
    [{ ticker: "BTCUSD", bid: 0n, ask: 0n, cleared: true }],
    "a one-sided book clears the quote",
  );
});

test("okx bbo-tbt messages and REST tickers", () => {
  const last = replay("okx");
  assert.deepEqual(last.get("BTC-USDT"), pair("84114.9", "84115"));
  assert.deepEqual(last.get("ETH-USDT"), pair("2616.47", "2616.48"));
  assert.deepEqual(last.get("PEPE-USDT"), pair("0.000004143", "0.000004144"));
  const rest = asMap(restQuotes("okx", ["BTC-USDT", "PEPE-USDT"]));
  assert.deepEqual([...rest.keys()].sort(), ["BTC-USDT", "PEPE-USDT"]);
  assert.equal(ADAPTERS.okx.pingMessage, "ping");
  assert.deepEqual(JSON.parse(ADAPTERS.okx.subscribeMessages(["BTC-USDT", "ETH-USDT"])[0]), {
    op: "subscribe",
    args: [
      { channel: "bbo-tbt", instId: "BTC-USDT" },
      { channel: "bbo-tbt", instId: "ETH-USDT" },
    ],
  });
  assert.deepEqual(ADAPTERS.okx.createParser()("pong"), []);
});

test("bybit orderbook.1 messages and REST tickers", () => {
  const last = replay("bybit");
  assert.deepEqual(last.get("BTCUSDT"), pair("84109.2", "84109.3"));
  assert.deepEqual(last.get("ETHUSDT"), pair("2615.75", "2615.76"));
  assert.deepEqual(last.get("PEPEUSDT"), pair("0.000004144", "0.000004146"));
  const rest = asMap(restQuotes("bybit", ["BTCUSDT", "ETHUSDT"]));
  assert.deepEqual(rest.get("ETHUSDT"), pair("2615.75", "2615.76"));
  assert.equal(rest.size, 2);
  const subscribe = ADAPTERS.bybit.subscribeMessages(Array.from({ length: 12 }, (_, i) => `T${i}USDT`));
  assert.equal(subscribe.length, 2, "at most 10 topics per request");
  // A delta that only moves the ask keeps the previous bid.
  const parse = ADAPTERS.bybit.createParser();
  parse(
    '{"topic":"orderbook.1.XUSDT","type":"snapshot","data":{"s":"XUSDT","b":[["10","1"]],"a":[["11","1"]]}}',
  );
  assert.deepEqual(
    parse('{"topic":"orderbook.1.XUSDT","type":"delta","data":{"s":"XUSDT","b":[],"a":[["10.5","2"]]}}'),
    [{ ticker: "XUSDT", ...pair("10", "10.5") }],
  );
});

test("binance bookTicker messages and REST bookTicker", () => {
  const last = replay("binance");
  assert.deepEqual(last.get("BTCUSDT"), pair("84112.06", "84112.07"));
  assert.deepEqual(last.get("ETHUSDT"), pair("2615.7", "2615.71"));
  const rest = asMap(restQuotes("binance", ["BTCUSDT", "PEPEUSDT"]));
  assert.deepEqual([...rest.keys()].sort(), ["BTCUSDT", "PEPEUSDT"]);
  assert.equal(
    ADAPTERS.binance.websocketUrl(["BTCUSDT", "ETHUSDT"]),
    "wss://data-stream.binance.vision/stream?streams=btcusdt@bookTicker/ethusdt@bookTicker",
  );
});

test("parsers ignore control messages and reject crossed or malformed books", () => {
  for (const exchange of Object.keys(ADAPTERS) as ExchangeName[]) {
    const parse = ADAPTERS[exchange].createParser();
    assert.deepEqual(parse("not json"), [], exchange);
    assert.deepEqual(parse('{"event":"subscribe"}'), [], exchange);
  }
  const crossed = JSON.stringify({ stream: "x", data: { s: "BTCUSDT", b: "101", a: "100" } });
  assert.deepEqual(ADAPTERS.binance.createParser()(crossed), [
    { ticker: "BTCUSDT", bid: 0n, ask: 0n, cleared: true },
  ]);
  const okxEmpty = JSON.stringify({
    arg: { channel: "bbo-tbt", instId: "BTC-USDT" },
    data: [{ bids: [["100", "1"]], asks: [] }],
  });
  assert.deepEqual(ADAPTERS.okx.createParser()(okxEmpty), [
    { ticker: "BTC-USDT", bid: 0n, ask: 0n, cleared: true },
  ]);
  assert.throws(() =>
    ADAPTERS.binance.createParser()(JSON.stringify({ data: { s: "BTCUSDT", b: "-1", a: "2" } })),
  );
});
