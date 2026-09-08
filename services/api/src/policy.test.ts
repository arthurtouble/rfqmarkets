import assert from "node:assert/strict";
import { test } from "node:test";
import { impactCost, requiredPendingImpact, type Exposure, type Market } from "../../../packages/shared/src/policy.js";

function exhaustive(settled:Exposure,pending:Array<{market:Market;delta:bigint}>,market:Market,delta:bigint){
  let greatest:bigint|undefined;
  for(let mask=0;mask<2**pending.length;mask++){
    const state={...settled};
    for(let index=0;index<pending.length;index++)if((mask&(1<<index))!==0)state[pending[index].market]+=pending[index].delta;
    const cost=impactCost(state,market,delta);if(greatest===undefined||cost>greatest)greatest=cost;
  }
  return greatest as bigint;
}

test("four-corner pending envelope is conservative against every execution subset",()=>{
  let seed=0x6d2b79f5;
  const random=()=>{seed=(Math.imul(seed^seed>>>15,1|seed)+Math.imul(seed^seed>>>7,61|seed))^seed;return (seed^seed>>>14)>>>0;};
  for(let sample=0;sample<250;sample++){
    const settled:Exposure={BTC:BigInt(random()%400_001-200_000)*1_000_000n,ETH:BigInt(random()%400_001-200_000)*1_000_000n};
    const pending=Array.from({length:random()%9},()=>({market:(random()%2===0?"BTC":"ETH") as Market,delta:BigInt(random()%50_001-25_000)*1_000_000n}));
    const market=(random()%2===0?"BTC":"ETH") as Market,delta=BigInt(random()%50_000+1)*1_000_000n*(random()%2===0?1n:-1n);
    assert(requiredPendingImpact(settled,pending,market,delta)>=exhaustive(settled,pending,market,delta));
  }
});

test("pending impact remains bounded work with many wallet reservations",()=>{
  const pending=Array.from({length:10_000},(_,index)=>({market:(index%2===0?"BTC":"ETH") as Market,delta:BigInt(index%5-2)*1_000_000n}));
  assert.equal(typeof requiredPendingImpact({BTC:0n,ETH:0n},pending,"BTC",1_000_000n),"bigint");
});
