import assert from "node:assert/strict";
import { test } from "node:test";
import { loadConfig } from "./config.js";
import { StaticMarketSource, parseMarkets } from "./markets.js";
import { EXCHANGES, SYMBOLS, STABLE_INSTRUMENTS, resolveSymbol } from "./symbols.js";

const KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const base = {
  ORACLE_SIGNER_KEY: KEY,
  ORACLE_CHAIN_ID: "8453",
  ORACLE_VERIFYING_CONTRACT: "0x000000000000000000000000000000000000dead",
};

test("config defaults and validation", () => {
  const config = loadConfig(base);
  assert.equal(config.chainId, 8453n);
  assert.equal(config.verifyingContract, "0x000000000000000000000000000000000000dEaD");
  assert.deepEqual(config.markets, [
    { id: 0, symbol: "BTC" },
    { id: 1, symbol: "ETH" },
  ]);
  assert.deepEqual(config.exchanges, [...EXCHANGES]);
  assert.deepEqual(config.aggregation, {
    maxAgeMs: 2_000,
    maxDeviationBps: 50,
    minSources: 3,
    maxWidthBps: 100,
  });
  assert.equal(config.tickMs, 1_000);
  assert.equal(config.candleRetentionMs, 24 * 3_600_000);
  assert.equal(loadConfig({ ...base, ORACLE_EXCHANGES: "kraken, OKX" }).exchanges.join(), "kraken,okx");
  for (const [name, value] of [
    ["ORACLE_SIGNER_KEY", ""],
    ["ORACLE_SIGNER_KEY", "0x1234"],
    ["ORACLE_CHAIN_ID", "abc"],
    ["ORACLE_VERIFYING_CONTRACT", "0x1234"],
    ["ORACLE_EXCHANGES", "ftx"],
    ["ORACLE_MIN_SOURCES", "0"],
    ["ORACLE_MARKETS", "0:BTC,0:ETH"],
  ])
    assert.throws(() => loadConfig({ ...base, [name]: value }), name);
  // The key is never part of an error message.
  try {
    loadConfig({ ...base, ORACLE_SIGNER_KEY: `${KEY}00` });
  } catch (error) {
    assert.doesNotMatch(String(error), /59c6995e/);
  }
});

test("market lists parse from short and JSON forms", async () => {
  assert.deepEqual(parseMarkets("1:ETH, 0:BTC,2:kPEPE"), [
    { id: 0, symbol: "BTC" },
    { id: 1, symbol: "ETH" },
    { id: 2, symbol: "kPEPE" },
  ]);
  assert.deepEqual(parseMarkets('[{"id":5,"symbol":"SOL"}]'), [{ id: 5, symbol: "SOL" }]);
  assert.throws(() => parseMarkets("0:NOPE"), /unknown/);
  assert.throws(() => parseMarkets("256:BTC"), /invalid market id/);
  assert.throws(() => parseMarkets("0:BTC,1:BTC"), /duplicate/);
  assert.deepEqual(await new StaticMarketSource().markets(), parseMarkets(undefined));
});

test("symbol table derives venue tickers by convention with exclusions", () => {
  const btc = resolveSymbol("BTC");
  assert.deepEqual(
    btc.instruments.map((instrument) => `${instrument.exchange}:${instrument.ticker}:${instrument.quote}`),
    [
      "coinbase:BTC-USD:USD",
      "kraken:BTC/USD:USD",
      "bitstamp:btcusd:USD",
      "gemini:BTCUSD:USD",
      "okx:BTC-USDT:USDT",
      "bybit:BTCUSDT:USDT",
      "binance:BTCUSDT:USDT",
    ],
  );
  assert.equal(resolveSymbol("kSHIB").instruments[0].ticker, "SHIB-USD");
  assert.equal(resolveSymbol("kSHIB").multiplier, 1_000n);
  assert.deepEqual(
    resolveSymbol("TON").instruments.map((instrument) => instrument.exchange),
    ["coinbase", "kraken", "bitstamp"],
  );
  assert.ok(Object.keys(SYMBOLS).length >= 30);
  for (const symbol of Object.keys(SYMBOLS))
    assert.ok(resolveSymbol(symbol).instruments.length >= 3, `${symbol} can reach the minimum source count`);
  assert.equal(resolveSymbol("BTC", undefined, ["kraken", "okx"]).instruments.length, 2);
  assert.ok(STABLE_INSTRUMENTS.USDT.length >= 2 && STABLE_INSTRUMENTS.USDC.length >= 2);
});
