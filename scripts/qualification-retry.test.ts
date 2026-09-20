import {test} from 'node:test';
import assert from 'node:assert/strict';
import {btcRetryDelay,QualificationResponseError,retryQualification,startQualificationApp,transientReadError} from './qualification-retry.js';
import Fastify from 'fastify';
import {buildApi} from '../services/api/src/server.js';
import {JsonRpcProvider} from 'ethers';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

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
test('BTC waits for reservations to expire only after an explicit timed-out quorum rejection',async()=>{
  const delays:number[]=[];let attempts=0;
  await retryQualification(async()=>{if(++attempts===1)throw new QualificationResponseError('/v1/approve',503,{error:'approver quorum unavailable',details:['TimeoutError: The operation was aborted due to timeout']});},btcRetryDelay,{sleep:async ms=>{delays.push(ms);}});
  assert.equal(attempts,2);assert.deepEqual(delays,[40_000]);
  for(const details of [undefined,[],['policy rejected'],['TimeoutError: aborted','policy rejected']])assert.equal(btcRetryDelay(new QualificationResponseError('/v1/approve',503,{error:'approver quorum unavailable',details})),null);
});
test('transient read retries remain bounded and reject contract failures',async()=>{
  const error=Object.assign(new Error('DNS unavailable'),{cause:{code:'ENOTFOUND'}});let calls=0;
  await assert.rejects(retryQualification(async()=>{calls++;throw error;},e=>transientReadError(e)?5000:null,{attempts:3,sleep:async()=>{}}),value=>value===error);assert.equal(calls,3);
  assert.equal(transientReadError({code:'CALL_EXCEPTION'}),false);
  assert.equal(btcRetryDelay(new QualificationResponseError('/v1/approve',409,{error:'price moved beyond signed protection'})),250);
});

test('qualification API retries startup DNS failure with a fresh instance and closes failed providers',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'rfq-startup-test-')),events:string[]=[],delays:number[]=[];let builds=0;
  class StartupProvider extends JsonRpcProvider {
    constructor(readonly attempt:number){super();}
    override async send(method:string):Promise<any>{
      assert.equal(method,'eth_getTransactionCount');events.push(`read:${this.attempt}`);
      if(this.attempt<3)throw Object.assign(new Error('DNS unavailable'),{code:'ENOTFOUND'});
      return '0x0';
    }
    override destroy(){events.push(`close:${this.attempt}`);super.destroy();}
  }
  try{
    const app=await startQualificationApp(()=>buildApi({approvers:[],journalPath:join(directory,'api.sqlite'),provider:new StartupProvider(++builds),chainId:84532n,chain:{rpcUrl:'https://unused.invalid',sponsorPrivateKey:'0x'+'1'.repeat(64),clearingAddress:'0x'+'2'.repeat(40),tokenAddress:'0x'+'3'.repeat(40)}}),{sleep:async ms=>{delays.push(ms);}});
    assert.equal(builds,3);assert.deepEqual(events,['read:1','close:1','read:2','close:2','read:3']);assert.deepEqual(delays,[5000,5000]);
    await app.close();assert.equal(events.at(-1),'close:3');
  }finally{rmSync(directory,{recursive:true,force:true});}
});

test('qualification startup retries are bounded and never retry non-transport failures',async()=>{
  for(const [code,expected] of [['ENOTFOUND',3],['CALL_EXCEPTION',1]] as const){
    let builds=0,closed=0;const error=Object.assign(new Error('startup failed'),{code});
    await assert.rejects(startQualificationApp(()=>{builds++;const app=Fastify();app.addHook('onReady',async()=>{throw error;});app.addHook('onClose',async()=>{closed++;});return app;},{attempts:3,sleep:async()=>{}}),value=>value===error);
    assert.equal(builds,expected);assert.equal(closed,expected);
  }
});
