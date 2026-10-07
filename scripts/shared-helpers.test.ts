import assert from "node:assert/strict";
import { test } from "node:test";
import { AbiCoder } from "ethers";
import { USDC, marginRate } from "../packages/shared/src/pricing.js";
import {
  marketMid,
  marketNotional,
  toExposureBook,
  toExposureMarket,
  toPosition,
  toSession,
} from "../packages/shared/src/clearing-structs.js";
import {
  MarketRegistry,
  encodeMarketSymbol,
  marketIndex,
  marketName,
  marketRegistry,
  marketSymbols,
  readMarketsFromChain,
  watchMarketRegistry,
  baseSpreadOf,
  DEFAULT_BASE_SPREAD_BPS,
  type MarketDefinition,
} from "../packages/shared/src/markets.js";
import { maskAllows } from "../packages/shared/src/clearing-structs.js";
import {
  BASE,
  MASK,
  abs,
  ceilDiv,
  decodeMarketLimitWord,
  high128,
  low128,
} from "../packages/shared/src/numeric.js";
import {
  decodeLocalReport,
  encodeLocalReport,
  ORACLE_OBSERVATION_TUPLE,
} from "../packages/shared/src/oracle-report.js";

test("numeric helpers", () => {
  assert.equal(abs(-3n), 3n);
  assert.equal(abs(3n), 3n);
  assert.equal(ceilDiv(7n, 2n), 4n);
  assert.equal(ceilDiv(8n, 2n), 4n);
  const word = 5n | (9n << 128n);
  assert.equal(low128(word), 5n);
  assert.equal(high128(word), 9n);
  assert.equal(low128(MASK + 1n), 0n);
  assert.deepEqual(decodeMarketLimitWord(word.toString()), { maxTradeNotional: 5n, maxMarketNotional: 9n });
});

test("market index mapping", () => {
  assert.deepEqual(marketSymbols(), ["BTC", "ETH"]);
  assert.equal(marketIndex("BTC"), 0);
  assert.equal(marketIndex("ETH"), 1);
  assert.equal(marketName(1n), "ETH");
  assert.throws(() => marketName(2), /unknown market index/);
  assert.throws(() => marketIndex("SOL"), /unknown market SOL/);
  assert.equal(marketRegistry.mask, 3n);
  assert(maskAllows(3n, 1) && !maskAllows(1, 1) && maskAllows(1n << 100n, 100));
});

const sol: MarketDefinition = {
  index: 2,
  symbol: "SOL",
  impactK: 20_000n,
  shockBps: 6_000n,
  marginScaleBps: 15_000,
  enabled: true,
};

/** A clearing reader over `markets`, as `marketCount`/`marketParams`/`markets` return them. */
const fakeClearing = (markets: MarketDefinition[]) => ({
  marketCount: async () => BigInt(markets.length),
  marketParams: async (index: number) => ({
    symbol: encodeMarketSymbol(markets[index].symbol),
    impactK: markets[index].impactK,
    shockBps: markets[index].shockBps,
    marginScaleBps: BigInt(markets[index].marginScaleBps),
  }),
  markets: async (index: number) => ({ enabled: markets[index].enabled }),
});

test("the registry loads from chain, grows append-only and notifies listeners", async () => {
  const registry = new MarketRegistry(),
    chainMarkets = [...registry.all()],
    clearing = fakeClearing(chainMarkets),
    changes: string[][] = [];
  assert.deepEqual(await readMarketsFromChain(clearing), chainMarkets);
  registry.onChange((markets) => changes.push(markets.map((market) => market.symbol)));
  const watch = await watchMarketRegistry(clearing, { registry, intervalMs: 60_000 });
  assert.deepEqual(changes, [], "the launch markets already match");
  chainMarkets.push(sol);
  await registry.ensureCount(3);
  assert.deepEqual(registry.symbols(), ["BTC", "ETH", "SOL"]);
  assert.equal(registry.get("SOL").shockBps, 6_000n);
  assert.equal(registry.mask, 7n);
  assert.deepEqual(changes, [["BTC", "ETH", "SOL"]]);
  await assert.rejects(registry.ensureCount(4), /behind the chain/);
  chainMarkets.pop();
  await assert.rejects(watch.refresh(), /cannot shrink/);
  assert.deepEqual(registry.symbols(), ["BTC", "ETH", "SOL"], "a failed refresh keeps the last list");
  watch.stop();
  assert.throws(() => registry.replace([{ ...sol, index: 0 }, sol]), /index 2, expected 1/);
  assert.throws(
    () => registry.replace([{ ...sol, index: 0, symbol: "bad symbol" }]),
    /invalid market symbol/,
  );
});

test("market spreads load from chain: own spread, then the default, and none on older contracts", async () => {
  const markets = [...new MarketRegistry().all()],
    own: Record<number, bigint> = { 0: 8n, 1: 0n };
  let defaultSpread = 5n;
  const clearing = {
    ...fakeClearing(markets),
    defaultSpread: async () => defaultSpread,
    marketSpread: async (index: number) => own[index],
  };
  const read = await readMarketsFromChain(clearing);
  assert.deepEqual(
    read.map((market) => [market.symbol, market.baseSpreadBps, baseSpreadOf(market)]),
    [
      ["BTC", 8, 8],
      ["ETH", 5, 5],
    ],
  );
  defaultSpread = 0n;
  assert.deepEqual(
    (await readMarketsFromChain(clearing)).map((market) => baseSpreadOf(market)),
    [8, DEFAULT_BASE_SPREAD_BPS],
  );
  // A contract without the views (empty return data) quotes the built-in default.
  const missing = Object.assign(new Error("could not decode result data"), { code: "BAD_DATA" });
  const legacy = { ...clearing, defaultSpread: async () => Promise.reject(missing) };
  assert.deepEqual(
    (await readMarketsFromChain(legacy)).map((market) => market.baseSpreadBps),
    [undefined, undefined],
  );
  // A network failure is not mistaken for an older contract.
  const down = { ...clearing, defaultSpread: async () => Promise.reject(new Error("socket hang up")) };
  await assert.rejects(readMarketsFromChain(down), /socket hang up/);
  // A spread change is a registry change listeners hear about.
  const registry = new MarketRegistry(read);
  let changes = 0;
  registry.onChange(() => changes++);
  assert.equal(registry.replace(read.map((market) => ({ ...market, baseSpreadBps: 12 }))), true);
  assert.equal(changes, 1);
});

test("an unknown symbol triggers a rate-limited early refresh", async () => {
  const registry = new MarketRegistry();
  let calls = 0;
  registry.setRefresher(async () => {
    calls++;
  });
  registry.requestRefresh(5_000, 10_000);
  registry.requestRefresh(5_000, 12_000);
  registry.requestRefresh(5_000, 16_000);
  assert.equal(calls, 2);
});

test("local oracle report codec round-trips the adapter tuple array", () => {
  const observation = { market: 1n, bid: 10n, ask: 11n, observedAt: 12n, validUntil: 13n };
  const report = encodeLocalReport({ ...observation, market: 1 });
  assert.equal(
    report,
    AbiCoder.defaultAbiCoder().encode([`${ORACLE_OBSERVATION_TUPLE}[]`], [[[1, 10n, 11n, 12n, 13n]]]),
  );
  assert.deepEqual(decodeLocalReport(report), [observation]);
  const pair = encodeLocalReport([{ ...observation, market: 0 }, observation]);
  assert.deepEqual(
    decodeLocalReport(pair).map((item) => item.market),
    [0n, 1n],
  );
});

test("clearing struct converters normalize ethers results to bigint models", () => {
  const market = toExposureMarket({
    aggregateBase: "-2000000000000000000",
    fundingIndex: 1,
    fundingTime: 2n,
    lastPriceTime: 3n,
    lastBid: 99n,
    lastAsk: 101n,
    enabled: 1,
  });
  assert.equal(market.enabled, true);
  assert.equal(marketMid(market), 100n);
  assert.equal(marketNotional(market), -200n);
  assert.equal(marketNotional(market, 50n), -100n);
  assert.deepEqual(toExposureBook({ longBase: 1, shortBase: "2", limits: 3n, ready: false }), {
    longBase: 1n,
    shortBase: 2n,
    limits: 3n,
    ready: false,
  });
  assert.deepEqual(toPosition({ size: -1, entryPrice: 2, lastFundingIndex: -3 }), {
    size: -1n,
    entryPrice: 2n,
    lastFundingIndex: -3n,
  });
  assert.equal(
    toSession({
      account: "0x1",
      validUntil: 1,
      marketMask: 3n,
      maxTradeNotional: 1,
      maxCumulativeNotional: 1,
      usedNotional: 0,
      maxFee: BASE,
    }).marketMask,
    3n,
  );
});

test("margin tiers keep the top tier above 5M notional, as the contract does", () => {
  assert.deepEqual(
    [marginRate(5_000_000n * USDC, true), marginRate(5_000_000n * USDC, false)],
    [10_000n, 6_000n],
  );
  assert.deepEqual(
    [marginRate(9_000_000n * USDC, true), marginRate(9_000_000n * USDC, false)],
    [10_000n, 6_000n],
  );
  assert.deepEqual([marginRate(25_000n * USDC, true), marginRate(25_000n * USDC, false)], [2_000n, 1_200n]);
});
