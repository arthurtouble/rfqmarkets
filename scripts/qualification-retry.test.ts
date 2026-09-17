import {test} from 'node:test';
import assert from 'node:assert/strict';
import {btcRetryDelay,QualificationResponseError,retryQualification,transientReadError} from './qualification-retry.js';

test('BTC retries pre-admission settlement loss with a fresh attempt',async()=>{
  let attempts=0;const delays:number[]=[];
  const result=await retryQualification(async()=>{if(++attempts<3)throw new QualificationResponseError('/v1/approve',503,{error:'fresh settlement price unavailable'});return 'included';},btcRetryDelay,{sleep:async ms=>{delays.push(ms);}});
  assert.equal(result,'included');assert.equal(attempts,3);assert.deepEqual(delays,[5000,5000]);
});
test('BTC never retries ambiguous submissions or unrelated rejections',async()=>{
  for(const error of [new QualificationResponseError('/v1/approve',503,{error:'chain submission failed'}),new QualificationResponseError('/v1/approve',409,{error:'policy rejected'}),new QualificationResponseError('/v1/quote',503,{error:'fresh settlement price unavailable'}),new Error('fresh settlement price unavailable'),Object.assign(new Error('timed out'),{code:'TIMEOUT'})]){
    let calls=0;await assert.rejects(retryQualification(async()=>{calls++;throw error;},btcRetryDelay),value=>value===error);assert.equal(calls,1);
  }
});
test('transient read retries remain bounded and reject contract failures',async()=>{
  const error=Object.assign(new Error('DNS unavailable'),{cause:{code:'ENOTFOUND'}});let calls=0;
  await assert.rejects(retryQualification(async()=>{calls++;throw error;},e=>transientReadError(e)?5000:null,{attempts:3,sleep:async()=>{}}),value=>value===error);assert.equal(calls,3);
  assert.equal(transientReadError({code:'CALL_EXCEPTION'}),false);
  assert.equal(btcRetryDelay(new QualificationResponseError('/v1/approve',409,{error:'price moved beyond signed protection'})),250);
});
