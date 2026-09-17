import assert from "node:assert/strict";
import {test} from "node:test";
import {requiredEnv} from "./lib/env.js";
import {randomNonce} from "./lib/http.js";

test("runtime nonces are unsigned decimal values with fresh entropy",()=>{
  const first=randomNonce(),second=randomNonce();
  assert.match(first,/^[0-9]+$/);
  assert.notEqual(first,second);
  assert(BigInt(first)>=0n);
});

test("required environment values reject missing and placeholder settings",()=>{
  const name="RFQ_TEST_REQUIRED_ENV_HELPER";
  const prior=process.env[name];
  try{
    delete process.env[name];assert.throws(()=>requiredEnv(name),/missing/);
    process.env[name]="replace_me";assert.throws(()=>requiredEnv(name),/missing/);
    assert.equal(requiredEnv(name,{allowPlaceholder:true}),"replace_me");
    process.env[name]="configured";assert.equal(requiredEnv(name),"configured");
  }finally{if(prior===undefined)delete process.env[name];else process.env[name]=prior;}
});
