import assert from "node:assert/strict";
import { test } from "node:test";
import { CHART_RANGES, STALE_PRICE_MS, dayChange, dayRange, priceChange, priceStatus, searchMarkets, type DayStats } from "./market-stats.js";
import { CANDLE_INTERVALS } from "./candles.js";
import type { MarketState } from "./types.js";

const stats: DayStats = { since: 0, open: "100000000", high: "120000000", low: "90000000", last: "110000000", change: "10000000", spark: ["100000000", "110000000"] };

test("price change is measured from the reference, and needs both prices", () => {
  assert.deepEqual(priceChange("100000000", "110000000"), { delta: 10, ratio: 0.1 });
  assert.deepEqual(priceChange(200_000_000n, 150_000_000n), { delta: -50, ratio: -0.25 });
  assert.equal(priceChange(null, "1"), null);
  assert.equal(priceChange("0", "1"), null);
});

test("24h change and range follow the live mid", () => {
  assert.equal(dayChange(undefined, "1"), null);
  assert.equal(dayChange(stats)?.ratio, 0.1);
  assert.equal(dayChange(stats, "80000000")?.ratio, -0.2);
  assert.deepEqual(dayRange(stats, "130000000"), { high: 130_000_000n, low: 90_000_000n });
  assert.deepEqual(dayRange(stats, "85000000"), { high: 120_000_000n, low: 85_000_000n });
  assert.deepEqual(dayRange(stats), { high: 120_000_000n, low: 90_000_000n });
});

test("search matches symbol or name, best matches first", () => {
  const names: Record<string, string> = { BTC: "Bitcoin", ETH: "Ethereum", SOL: "Solana", BCH: "Bitcoin Cash", TAO: "Bittensor" };
  const name = (market: string) => names[market] ?? market;
  const markets = ["BTC", "ETH", "SOL", "BCH", "TAO"];
  assert.deepEqual(searchMarkets(markets, "", name), markets);
  assert.deepEqual(searchMarkets(markets, "  sol ", name), ["SOL"]);
  assert.deepEqual(searchMarkets(markets, "bit", name), ["BTC", "BCH", "TAO"], "name prefix keeps list order");
  assert.deepEqual(searchMarkets(markets, "b", name), ["BTC", "BCH", "TAO"], "symbol prefix before name prefix");
  assert.deepEqual(searchMarkets(markets, "cash", name), ["BCH"]);
  assert.deepEqual(searchMarkets(markets, "eth", name), ["ETH"]);
  assert.deepEqual(searchMarkets(markets, "doge", name), []);
});

test("price status tells live, delayed, paused and missing prices apart", () => {
  const live = { enabled: true, observedAtMs: 1_000 } as MarketState;
  const fresh = { streamLive: true, nowMs: 2_000, receivedAtMs: 1_500, serverTimeMs: 1_200 };
  assert.equal(priceStatus(undefined, fresh), "unavailable");
  assert.equal(priceStatus(live, fresh), "live");
  assert.equal(priceStatus({ ...live, enabled: false }, fresh), "paused");
  assert.equal(priceStatus(live, { ...fresh, streamLive: false }), "delayed");
  assert.equal(priceStatus(live, { ...fresh, nowMs: 1_500 + STALE_PRICE_MS + 1 }), "delayed", "no snapshot for too long");
  assert.equal(priceStatus(live, { ...fresh, serverTimeMs: 1_000 + STALE_PRICE_MS + 1 }), "delayed", "server kept an old oracle price");
  assert.equal(priceStatus(live, { ...fresh, receivedAtMs: null, serverTimeMs: undefined }), "live");
});

test("every chart range fits the gateway's candle limit", () => {
  for (const [id, range] of Object.entries(CHART_RANGES)) {
    assert(range.limit >= 2 && range.limit <= 1_000, id);
    assert(CANDLE_INTERVALS[range.interval], id);
  }
});
