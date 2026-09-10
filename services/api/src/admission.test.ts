import assert from "node:assert/strict";
import {test} from "node:test";
import {QuoteAdmission} from "./admission.js";

test("quote admission bounds client cardinality and refills deterministically",()=>{
  const admission=new QuoteAdmission(1,2,2,100,100,1_000);
  assert(admission.allow("a",1_000));assert(admission.allow("a",1_000));assert.equal(admission.allow("a",1_000),false);
  assert(admission.allow("b",1_000));assert(admission.allow("c",1_000));assert.equal(admission.clientCount,2);
  assert(admission.allow("a",2_000),"evicted clients may re-enter after bounded churn");assert.equal(admission.clientCount,2);
});
