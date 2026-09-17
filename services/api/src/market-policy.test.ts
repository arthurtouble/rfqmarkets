import assert from "node:assert/strict";
import {test} from "node:test";
import {decodeLimits,quoteSpread,shadowQuoteSpread,staleOracleFailure} from "./market-policy.js";

test("packed market limits decode into independent uint128 values",()=>{
  const trade=123_456n,market=9_876_543n;
  assert.deepEqual(decodeLimits((market<<128n)|trade),{maxTradeNotional:trade,maxMarketNotional:market});
});

test("shadow pricing remains at least as conservative as active pricing",()=>{
  const snapshot={market:"BTC" as const,bid:99_990_000_000n,ask:100_010_000_000n,observedAtMs:1,volatilityBps:24};
  const active=quoteSpread(snapshot,"guarded",700,{estimatedCostBps:3,latencyMs:150,basisBps:2});
  const shadow=shadowQuoteSpread(snapshot,"guarded",700,{estimatedCostBps:3,latencyMs:150,basisBps:2});
  assert(shadow.totalBps>=active.totalBps);
});

test("stale oracle failures recognize names and deployed selectors",()=>{
  assert(staleOracleFailure(new Error("StalePrice")));
  assert(staleOracleFailure({data:"0xd7815800"}));
  assert(!staleOracleFailure(new Error("insufficient margin")));
});
