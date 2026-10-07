import assert from "node:assert/strict";
import { test } from "node:test";
import { marketInfos, symbolsByIndex } from "./markets.js";
import { marketFromIndex, type ChainConfig, type MarketSnapshot, type MarketState } from "./types.js";

const config: ChainConfig = {
  chainId: "0x1", chainName: "Test", clearingAddress: "0x0000000000000000000000000000000000000001",
  marketList: [{ index: 0, symbol: "BTC", enabled: true }, { index: 1, symbol: "ETH", enabled: true }, { index: 2, symbol: "SOL", enabled: false }],
  markets: {
    BTC: { marginScaleBps: 10_000, maxLeverage: 5, initialMarginBps: 2_000, maintenanceMarginBps: 1_200 },
    SOL: { marginScaleBps: 5_000, maxLeverage: 10, initialMarginBps: 1_000, maintenanceMarginBps: 600 },
  },
};
const live = (market: string, extra: Partial<MarketState> = {}) => ({ market, enabled: true, ...extra }) as MarketState;

test("lists every registered market in index order with margin", () => {
  const list = marketInfos(config, null);
  assert.deepEqual(list.map(item => [item.symbol, item.index, item.enabled, item.maxLeverage]), [["BTC", 0, true, 5], ["ETH", 1, true, 5], ["SOL", 2, false, 10]]);
  // ETH has no config margin: the 1x defaults apply.
  assert.equal(list[1].initialMarginBps, 2_000);
  assert.equal(list.every(item => !item.priced), true);
});

test("the live snapshot overrides margin and adds markets the config has not listed yet", () => {
  const snapshot = { markets: { BTC: live("BTC", { index: 0, marginScaleBps: 2_500, maxLeverage: 20, initialMarginBps: 500, maintenanceMarginBps: 300 }), DOGE: live("DOGE", { index: 3, marginScaleBps: 5_000, maxLeverage: 10 }) } } as unknown as MarketSnapshot;
  const list = marketInfos(config, snapshot);
  assert.deepEqual(list.map(item => item.symbol), ["BTC", "ETH", "SOL", "DOGE"]);
  assert.equal(list[0].maxLeverage, 20);
  assert.equal(list[0].priced, true);
  assert.equal(list[3].initialMarginBps, 1_000);
  const symbols = symbolsByIndex(list);
  assert.equal(marketFromIndex(3, symbols), "DOGE");
  assert.equal(marketFromIndex(4, symbols), null);
  assert.equal(marketFromIndex(null, symbols), null);
});

test("falls back to the launch markets with nothing loaded", () => {
  assert.deepEqual(marketInfos(null, null).map(item => item.symbol), ["BTC", "ETH"]);
  assert.equal(marketFromIndex(1), "ETH");
});
