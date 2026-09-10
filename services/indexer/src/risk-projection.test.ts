import assert from "node:assert/strict";
import test from "node:test";
import { RiskProjection } from "./risk-projection.js";

test("risk projection replaces accounts without double counting",()=>{
  const view=new RiskProjection();view.update({account:"a",collateral:"100",btc_size:"10",eth_size:"-3"});view.update({account:"b",collateral:"50",btc_size:"-4",eth_size:"0"});
  assert.deepEqual(view.snapshot(7),{indexedBlock:7,accountCount:2,totalCollateral:"150",markets:{BTC:{longBase:"10",shortBase:"4",netBase:"6",longAccounts:1,shortAccounts:1},ETH:{longBase:"0",shortBase:"3",netBase:"-3",longAccounts:0,shortAccounts:1}}});
  view.update({account:"a",collateral:"80",btc_size:"0",eth_size:"5"});
  assert.deepEqual(view.snapshot(8),{indexedBlock:8,accountCount:2,totalCollateral:"130",markets:{BTC:{longBase:"0",shortBase:"4",netBase:"-4",longAccounts:0,shortAccounts:1},ETH:{longBase:"5",shortBase:"0",netBase:"5",longAccounts:1,shortAccounts:0}}});
  view.clear();assert.equal(view.snapshot(9).accountCount,0);
});
