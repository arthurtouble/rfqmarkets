import assert from "node:assert/strict";
import {test} from "node:test";
import {partialCloseDelta} from "./close-quote.js";

test("partial close delta reduces long and short positions without flipping",()=>{
  assert.equal(partialCloseDelta(10_000n,2_500),-2_500n);
  assert.equal(partialCloseDelta(-10_000n,7_500),7_500n);
  assert.equal(partialCloseDelta(10_001n,10_000),-10_001n);
  assert.throws(()=>partialCloseDelta(1n,1),/below base precision/);
  assert.throws(()=>partialCloseDelta(0n,10_000),/already closed/);
});
