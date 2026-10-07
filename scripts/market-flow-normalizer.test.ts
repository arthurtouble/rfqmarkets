import assert from "node:assert/strict";
import { test } from "node:test";
import { BinanceNormalizer, CoinbaseNormalizer, toCsv } from "./market-flow-normalizer.js";

test("normalizes Coinbase matches and joins the latest ticker BBO", () => {
  const normalizer = new CoinbaseNormalizer();
  assert.equal(
    normalizer.normalize({ type: "ticker", product_id: "BTC-USD", best_bid: "100", best_ask: "100.2" }),
    undefined,
  );
  const value = normalizer.normalize({
    type: "match",
    product_id: "BTC-USD",
    trade_id: 42,
    price: "100.10",
    size: "0.25",
    side: "buy",
    time: "2026-01-01T00:00:00.000Z",
  });
  assert.deepEqual(value, {
    timestampMs: 1767225600000,
    venue: "coinbase",
    market: "BTC",
    tradeId: "42",
    price: 100.1,
    sizeBase: 0.25,
    takerSide: "sell",
    bid: 100,
    ask: 100.2,
  });
  assert.match(toCsv(value!), /^1767225600000,coinbase,BTC,42,/);
});

test("joins Binance aggregate trades to the latest valid BBO", () => {
  const normalizer = new BinanceNormalizer();
  assert.equal(
    normalizer.normalize({
      stream: "btcusdt@bookTicker",
      data: { u: 1, s: "BTCUSDT", b: "99990", a: "100010" },
    }),
    undefined,
  );
  assert.deepEqual(
    normalizer.normalize({
      stream: "btcusdt@aggTrade",
      data: { e: "aggTrade", s: "BTCUSDT", a: 9, p: "100000", q: "0.1", T: 1767225600100, m: false },
    }),
    {
      timestampMs: 1767225600100,
      venue: "binance",
      market: "BTC",
      tradeId: "9",
      price: 100000,
      sizeBase: 0.1,
      takerSide: "buy",
      bid: 99990,
      ask: 100010,
    },
  );
});

test("rejects malformed and snapshot market events", () => {
  const normalizer = new CoinbaseNormalizer();
  assert.equal(normalizer.normalize({ type: "ticker", product_id: "DOGE-USD" }), undefined);
  assert.equal(
    normalizer.normalize({
      type: "last_match",
      product_id: "ETH-USD",
      trade_id: 1,
      price: "100",
      size: "1",
      side: "sell",
      time: "2026-01-01T00:00:00Z",
    }),
    undefined,
  );
});
