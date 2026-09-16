import assert from "node:assert/strict";
import test from "node:test";
import {portForPath} from "./routing.mjs";

test("routes only the intended public runtime surface",()=>{
  assert.equal(portForPath("/health"),4300);
  assert.equal(portForPath("/v1/risk"),4300);
  assert.equal(portForPath("/v1/updates/stream"),4300);
  assert.equal(portForPath("/v1/markets/stream"),4500);
  assert.equal(portForPath("/v1/markets/history"),4500);
  assert.equal(portForPath("/v1/quote"),4100);
  assert.equal(portForPath("/internal/risk"),null);
  assert.equal(portForPath("/approve"),null);
});
