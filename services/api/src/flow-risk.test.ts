import assert from "node:assert/strict";
import {test} from "node:test";
import {FlowRiskTracker} from "./flow-risk.js";

const snapshot=(mid:number)=>({market:"BTC" as const,bid:BigInt(mid-1),ask:BigInt(mid+1),observedAtMs:2_000});
test("toxicity uses paid fills and adverse post-trade markouts",()=>{const tracker=new FlowRiskTracker();tracker.record("BTC",{side:"buy",price:100_000n,notional:100_000_000_000n,atMs:1_000});assert.equal(tracker.score("BTC",snapshot(100_000),2_000),0);assert(tracker.score("BTC",snapshot(100_200),2_000)>0);});
test("favorable fills do not create toxicity and old evidence decays",()=>{const tracker=new FlowRiskTracker(32,1_000);tracker.record("BTC",{side:"sell",price:100_000n,notional:100_000_000_000n,atMs:1_000});assert.equal(tracker.score("BTC",snapshot(100_200),2_000),0);assert.equal(tracker.score("BTC",snapshot(99_800),20_000),0);});
test("tracker is market-wide, bounded, and capacity limited",()=>{const tracker=new FlowRiskTracker(4);for(let index=0;index<10;index++)tracker.record("BTC",{side:"buy",price:100_000n,notional:1_000_000_000_000n,atMs:1_000+index});assert.equal(tracker.size("BTC"),4);assert.equal(tracker.size("ETH"),0);assert(tracker.score("BTC",snapshot(120_000),2_000)<=10_000);});
test("paid-flow evidence survives a leader restart",()=>{const persisted=[{market:"BTC" as const,side:"buy" as const,price:100_000n,notional:250_000_000_000n,atMs:1_000}];const first=new FlowRiskTracker(32,30_000,persisted),restored=new FlowRiskTracker(32,30_000,first.entries());assert.equal(restored.size("BTC"),1);assert.equal(restored.score("BTC",snapshot(100_500),2_000),first.score("BTC",snapshot(100_500),2_000));});
