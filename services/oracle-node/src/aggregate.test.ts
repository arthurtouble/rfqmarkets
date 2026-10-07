import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_AGGREGATION,
  DEFAULT_STABLE,
  aggregateMarket,
  marketQuotes,
  stableRate,
  toUsd,
  type SourceQuote,
} from "./aggregate.js";
import { formatPrice, parseDecimal } from "./decimal.js";
import { resolveSymbol } from "./symbols.js";

const NOW = 1_000_000;
const q = (source: string, bid: string, ask: string, ageMs = 0): SourceQuote => ({
  source,
  bid: parseDecimal(bid),
  ask: parseDecimal(ask),
  asOfMs: NOW - ageMs,
});

test("parseDecimal is exact for strings, JSON numbers and exponents", () => {
  assert.equal(parseDecimal("84074.3"), 84_074_300_000_000_000_000_000n);
  assert.equal(parseDecimal(0.000004143), 4_143_000_000_000n);
  assert.equal(parseDecimal(1.2e-7), 120_000_000_000n);
  assert.equal(parseDecimal("1E+2"), 100n * 10n ** 18n);
  assert.equal(parseDecimal("0.1234567890123456789"), 123_456_789_012_345_678n, "truncates past 18 decimals");
  assert.equal(formatPrice(parseDecimal("2615.010")), "2615.01");
  for (const bad of ["", "-1", "1,5", "abc", "NaN", Infinity, null])
    assert.throws(() => parseDecimal(bad), String(bad));
});

test("median of mids with outward rounding to micro-units", () => {
  const result = aggregateMarket(
    [q("a", "100.00", "100.02"), q("b", "100.01", "100.03"), q("c", "100.02", "100.04")],
    NOW,
  );
  assert.ok(result.ok);
  // mids 100.01, 100.02, 100.03 -> median 100.02, half 0.01.
  assert.equal(result.bid, 100_010_000n);
  assert.equal(result.ask, 100_030_000n);
  assert.deepEqual(result.sources, ["a", "b", "c"]);
  const fractional = aggregateMarket(
    [q("a", "1.0000001", "1.0000001"), q("b", "1.0000001", "1.0000001"), q("c", "1.0000001", "1.0000001")],
    NOW,
  );
  assert.ok(fractional.ok);
  assert.equal(fractional.bid, 1_000_000n, "bid rounds down");
  assert.equal(fractional.ask, 1_000_001n, "ask rounds up");
  // Even count: the median is the average of the two middle mids.
  const even = aggregateMarket(
    [
      q("a", "100", "100"),
      q("b", "100.02", "100.02"),
      q("c", "100.04", "100.04"),
      q("d", "100.06", "100.06"),
    ],
    NOW,
  );
  assert.ok(even.ok);
  assert.equal(even.median, parseDecimal("100.03"));
  assert.equal(even.bid, 100_000_000n);
  assert.equal(even.ask, 100_060_000n);
});

test("stale sources are dropped", () => {
  const quotes = [
    q("a", "100", "100"),
    q("b", "100", "100", 2_000),
    q("c", "100", "100", 2_001),
    q("d", "100", "100", 500),
  ];
  const result = aggregateMarket(quotes, NOW);
  assert.ok(result.ok);
  assert.deepEqual(result.sources, ["a", "b", "d"], "exactly maxAgeMs is still fresh");
  const failed = aggregateMarket(quotes.slice(1, 3), NOW);
  assert.deepEqual(failed, { ok: false, reason: "insufficient-sources", sources: ["b"] });
  assert.ok(aggregateMarket(quotes, NOW, { ...DEFAULT_AGGREGATION, maxAgeMs: 5_000 }).ok);
});

test("outliers beyond maxDeviationBps are dropped and the median recomputed", () => {
  const result = aggregateMarket(
    [
      q("a", "100", "100"),
      q("b", "100.1", "100.1"),
      q("c", "100.2", "100.2"),
      q("d", "100.5", "100.5"), // 29.9 bps from the first median (100.2): kept
      q("e", "101", "101"), // 79.8 bps: dropped
      q("f", "95", "95"), // dropped
    ],
    NOW,
  );
  assert.ok(result.ok);
  assert.deepEqual(result.sources, ["a", "b", "c", "d"]);
  // Recomputed median of 100, 100.1, 100.2, 100.5 = 100.15; half = 0.35.
  assert.equal(result.median, parseDecimal("100.15"));
  assert.equal(result.bid, 99_800_000n);
  assert.equal(result.ask, 100_500_000n);
});

test("fewer than minSources survivors omits the market", () => {
  const quotes = [q("a", "100", "100"), q("b", "100", "100"), q("c", "110", "110"), q("d", "90", "90")];
  // median 100; c and d are 1000 bps away.
  assert.deepEqual(aggregateMarket(quotes, NOW), {
    ok: false,
    reason: "insufficient-sources",
    sources: ["a", "b"],
  });
  assert.ok(aggregateMarket(quotes, NOW, { ...DEFAULT_AGGREGATION, minSources: 2 }).ok);
  assert.deepEqual(aggregateMarket([], NOW), { ok: false, reason: "insufficient-sources", sources: [] });
  // Invalid quotes never count.
  const invalid = { source: "x", bid: 0n, ask: parseDecimal("100"), asOfMs: NOW };
  assert.equal(aggregateMarket([invalid, quotes[0], quotes[1]], NOW).ok, false);
});

test("signed width above maxWidthBps omits the market", () => {
  // mids 100, 100.5, 100.5 -> median 100.5, half 0.5 -> 100 / 101 = 99.5 bps (allowed).
  const allowed = aggregateMarket(
    [q("a", "100", "100"), q("b", "100.5", "100.5"), q("c", "100.5", "100.5")],
    NOW,
  );
  assert.ok(allowed.ok);
  assert.equal(allowed.bid, 100_000_000n);
  assert.equal(allowed.ask, 101_000_000n);
  // median 100.495, half 0.505 -> 99.99 / 101.00: width 1.01 on a mid of 100.495 = 100.5 bps.
  const wide = aggregateMarket(
    [q("a", "99.99", "99.99"), q("b", "100.495", "100.495"), q("c", "100.495", "100.495")],
    NOW,
    { ...DEFAULT_AGGREGATION, maxDeviationBps: 60 },
  );
  assert.equal(wide.ok, false);
  assert.equal(!wide.ok && wide.reason, "too-wide");
  assert.equal(
    aggregateMarket([q("a", "100", "100"), q("b", "100.5", "100.5"), q("c", "100.5", "100.5")], NOW, {
      ...DEFAULT_AGGREGATION,
      maxWidthBps: 50,
    }).ok,
    false,
  );
});

test("USDT conversion uses the live USDT/USD rate", () => {
  const rate = stableRate([q("kraken", "0.9996", "0.9997"), q("coinbase", "0.9995", "0.9996")], NOW)!;
  assert.equal(rate, parseDecimal("0.9996"));
  const converted = toUsd(q("binance", "84000", "84000.1"), "USDT", { USDT: rate })!;
  assert.equal(converted.bid, parseDecimal("83966.4"));
  assert.equal(converted.ask, parseDecimal("83966.49996"));
  assert.equal(toUsd(q("okx", "1", "1"), "USDT", {}), undefined, "no rate -> the source is dropped");
  assert.equal(stableRate([q("kraken", "0.9996", "0.9997")], NOW), undefined, "needs minSources");
  assert.equal(
    stableRate([q("kraken", "1", "1"), q("coinbase", "1", "1", 2_500)], NOW),
    undefined,
    "stale rate",
  );
  assert.equal(
    stableRate([q("kraken", "0.94", "0.94"), q("coinbase", "0.94", "0.94")], NOW),
    undefined,
    "a depeg beyond maxDepegBps fails closed",
  );
  assert.equal(
    stableRate([q("kraken", "0.96", "0.96"), q("coinbase", "0.96", "0.96")], NOW),
    parseDecimal("0.96"),
  );
});

test("USDC is treated at par only within usdcParBps", () => {
  const usdc = q("x", "84000", "84000");
  assert.equal(toUsd(usdc, "USDC", { USDC: parseDecimal("0.9991") }), usdc, "9 bps -> par");
  assert.equal(toUsd(usdc, "USDC", { USDC: parseDecimal("0.999") }), usdc, "10 bps -> par");
  assert.equal(
    toUsd(usdc, "USDC", { USDC: parseDecimal("0.9989") })!.bid,
    parseDecimal("83907.6"),
    "11 bps -> converted",
  );
  assert.equal(toUsd(usdc, "USDC", {}), undefined);
  assert.equal(toUsd(usdc, "USD", {}), usdc);
  assert.equal(DEFAULT_STABLE.usdcParBps, 10);
});

test("market quotes apply stablecoin conversion and the lot multiplier", () => {
  const resolved = resolveSymbol("kPEPE");
  assert.equal(resolved.multiplier, 1_000n);
  const raw: Record<string, { bid: bigint; ask: bigint; asOfMs: number }> = {
    "kraken:PEPE/USD": { bid: parseDecimal("0.000004143"), ask: parseDecimal("0.000004144"), asOfMs: NOW },
    "binance:PEPEUSDT": { bid: parseDecimal("0.000004144"), ask: parseDecimal("0.000004146"), asOfMs: NOW },
    "okx:PEPE-USDT": { bid: parseDecimal("0.000004143"), ask: parseDecimal("0.000004144"), asOfMs: NOW },
  };
  const quotes = marketQuotes(resolved, (exchange, ticker) => raw[`${exchange}:${ticker}`], {
    USDT: parseDecimal("0.999"),
  });
  assert.deepEqual(
    quotes.map((quote) => quote.source),
    ["kraken", "okx", "binance"],
  );
  assert.equal(quotes[0].bid, parseDecimal("0.004143"));
  assert.equal(quotes[2].bid, parseDecimal("0.004139856"));
  const result = aggregateMarket(quotes, NOW);
  assert.ok(result.ok);
  assert.ok(result.bid >= 4_138n && result.ask <= 4_145n);
  assert.equal(
    marketQuotes(resolved, (exchange, ticker) => raw[`${exchange}:${ticker}`], {}).length,
    1,
    "USDT venues drop out without a rate",
  );
});
