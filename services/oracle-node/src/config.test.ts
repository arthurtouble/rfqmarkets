import assert from "node:assert/strict";
import { test } from "node:test";
import { loadConfig } from "./config.js";
import { encodeBytes32String } from "ethers";
import { ChainMarketSource, StaticMarketSource, parseMarkets } from "./markets.js";
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
  assert.throws(
    () => parseMarkets("128:BTC"),
    /invalid market id/,
    "the clearing contract holds 128 markets",
  );
});

/** A clearing registry fake: `symbols[i]` is market i. */
function registryReader(symbols: string[], fail = { now: false }) {
  return {
    marketCount: async () => {
      if (fail.now) throw new Error("rpc down");
      return BigInt(symbols.length);
    },
    marketParams: async (index: number) => ({
      symbol: encodeBytes32String(symbols[index]),
      impactK: 10_000n,
      shockBps: 4_000n,
      marginScaleBps: 10_000n,
    }),
    markets: async () => ({ enabled: true }),
  };
}

test("the chain market source prices every registered market the symbol table knows", async () => {
  const logged: string[] = [],
    fail = { now: false },
    symbols = ["BTC", "ETH"],
    source = new ChainMarketSource(registryReader(symbols, fail), {
      fallback: parseMarkets(undefined),
      log: (message) => logged.push(message),
    });
  assert.deepEqual(await source.markets(), parseMarkets(undefined));
  // Governance adds SOL and an asset the node has no venues for.
  symbols.push("SOL", "NOPE");
  assert.deepEqual(await source.markets(), parseMarkets("0:BTC,1:ETH,2:SOL"));
  await source.markets();
  assert.equal(logged.length, 1, "a skipped market is logged once");
  assert.match(logged[0], /3:NOPE is not priced by this node: no oracle symbol table entry/);
  // After a successful read an RPC failure throws, so the node keeps its current list.
  fail.now = true;
  await assert.rejects(source.markets(), /rpc down/);
  // ORACLE_MARKETS restricts a chain source, and an index that disagrees with the chain is skipped.
  const restricted = new ChainMarketSource(registryReader(["BTC", "ETH", "SOL"]), {
    allow: parseMarkets("0:BTC,5:SOL"),
    log: (message) => logged.push(message),
  });
  assert.deepEqual(await restricted.markets(), [{ id: 0, symbol: "BTC" }]);
  assert.match(logged.at(-1)!, /lists SOL as market 5, the chain as 2/);
  // An RPC that reports another symbol for a pinned index gets nothing signed for that index.
  const swapped = new ChainMarketSource(registryReader(["ETH", "BTC", "SOL"]), {
    allow: parseMarkets("0:BTC,1:ETH,2:SOL"),
    log: (message) => logged.push(message),
  });
  assert.deepEqual(await swapped.markets(), [{ id: 2, symbol: "SOL" }]);
  assert.ok(logged.some((line) => /pins market 0 to BTC, the chain reports ETH/.test(line)));
  const spoofed = new ChainMarketSource(registryReader(["PEPE"]), { allow: parseMarkets("0:BTC") });
  assert.deepEqual(await spoofed.markets(), []);
  // A node can start on its configured list while the RPC is down.
  const starting = new ChainMarketSource(registryReader(["BTC"], { now: true }), {
    fallback: parseMarkets("0:BTC"),
  });
  assert.deepEqual(await starting.markets(), [{ id: 0, symbol: "BTC" }]);
});

test("config reads the market registry location", () => {
  const config = loadConfig({
    ...base,
    ORACLE_RPC_URL: "http://127.0.0.1:8545",
    ORACLE_CLEARING_ADDRESS: "0x000000000000000000000000000000000000beef",
  });
  assert.deepEqual(config.registry, {
    rpcUrl: "http://127.0.0.1:8545",
    clearing: "0x000000000000000000000000000000000000bEEF",
    refreshMs: 60_000,
  });
  assert.equal(config.marketsConfigured, false);
  assert.equal(loadConfig(base).registry, undefined);
  assert.throws(() => loadConfig({ ...base, ORACLE_RPC_URL: "http://127.0.0.1:8545" }), /set together/);
  // A remote registry RPC must be https: it decides which symbol each signed index is priced as.
  assert.throws(
    () =>
      loadConfig({
        ...base,
        ORACLE_RPC_URL: "http://rpc.example",
        ORACLE_CLEARING_ADDRESS: "0x000000000000000000000000000000000000beef",
      }),
    /ORACLE_RPC_URL must be an https URL/,
  );
  assert.equal(
    loadConfig({
      ...base,
      ORACLE_RPC_URL: "https://rpc.example",
      ORACLE_CLEARING_ADDRESS: "0x000000000000000000000000000000000000beef",
    }).registry?.rpcUrl,
    "https://rpc.example",
  );
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
