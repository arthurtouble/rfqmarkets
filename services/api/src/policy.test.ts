import assert from "node:assert/strict";
import { test } from "node:test";
import { adaptiveSpread, constructQuote, impactCost, requiredPendingImpact, USDC, type Exposure, type Market } from "../../../packages/shared/src/policy.js";

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

test("market parameters permit scale quotes while preserving the configured ceiling",()=>{
  const snapshot={market:"BTC" as const,bid:99_990n*USDC,ask:100_010n*USDC,observedAtMs:1_000};
  const parameters={maxNotional:1_000_000n*USDC,baseSpreadBps:2n,feeBps:2n,toleranceBps:8n};
  const quote=constructQuote({market:"BTC",side:"buy",amount:"1000000"},snapshot,{BTC:0n,ETH:0n},[],1_000,"00000000-0000-4000-8000-000000000001",parameters);
  assert.equal(quote.notional,1_000_000n*USDC);
  assert.throws(()=>constructQuote({market:"BTC",side:"buy",amount:"1000000.000001"},snapshot,{BTC:0n,ETH:0n},[],1_000,crypto.randomUUID(),parameters),/market limit/);
});

test("splitting an order across wallets cannot reduce quadratic inventory impact",()=>{
  const start:Exposure={BTC:400_000n*USDC,ETH:-100_000n*USDC},part=50_000n*USDC;
  const bulk=impactCost(start,"BTC",part*10n);let sequential=0n,current={...start};
  for(let index=0;index<10;index++){sequential+=impactCost(current,"BTC",part);current.BTC+=part;}
  assert.equal(sequential,bulk);
  const pending=Array.from({length:10},()=>({market:"BTC" as const,delta:part}));
  assert(requiredPendingImpact(start,pending,"BTC",part)>=impactCost({...start,BTC:start.BTC+part*10n},"BTC",part));
});

test("adaptive risk components are monotone, bounded, and identity independent",()=>{
  const calm=adaptiveSpread({volatilityBps:5,toxicityScoreBps:100,hedgeLatencyMs:50,hedgeCostBps:1,venueBasisBps:1,confidenceBps:1});
  const volatile=adaptiveSpread({volatilityBps:100,toxicityScoreBps:100,hedgeLatencyMs:50,hedgeCostBps:1,venueBasisBps:1,confidenceBps:1});
  const toxic=adaptiveSpread({volatilityBps:100,toxicityScoreBps:8_000,hedgeLatencyMs:50,hedgeCostBps:1,venueBasisBps:1,confidenceBps:1});
  const impaired=adaptiveSpread({volatilityBps:100,toxicityScoreBps:8_000,hedgeLatencyMs:5_000,hedgeCostBps:12,venueBasisBps:15,confidenceBps:20,riskMode:"guarded"});
  assert(calm.totalBps<volatile.totalBps);
  assert(volatile.totalBps<toxic.totalBps);
  assert(toxic.totalBps<impaired.totalBps);
  assert.equal(adaptiveSpread({volatilityBps:20_000,toxicityScoreBps:20_000,hedgeLatencyMs:99_000,hedgeCostBps:99,venueBasisBps:999,confidenceBps:999}).totalBps,100n);
  assert.deepEqual(adaptiveSpread({volatilityBps:12}),adaptiveSpread({volatilityBps:12}));
});

test("adaptive spread is charged outside the contract-verifiable inventory floor",()=>{
  const snapshot={market:"BTC" as const,bid:99_990n*USDC,ask:100_010n*USDC,observedAtMs:1_000,volatilityBps:50};
  const spread=adaptiveSpread({volatilityBps:50,toxicityScoreBps:2_000});
  const parameters={maxNotional:1_000_000n*USDC,baseSpreadBps:spread.totalBps,feeBps:2n,toleranceBps:8n,spread};
  const quote=constructQuote({market:"BTC",side:"buy",amount:"100000"},snapshot,{BTC:0n,ETH:0n},[],1_000,crypto.randomUUID(),parameters);
  assert.equal(quote.spread?.modelVersion,"adaptive-v1");
  assert.equal(quote.impactCharge,impactCost({BTC:0n,ETH:0n},"BTC",100_000n*USDC));
  assert(quote.expectedPrice>snapshot.ask);
});
