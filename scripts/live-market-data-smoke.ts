import assert from "node:assert/strict";

const api=process.env.RFQ_API_URL??"http://127.0.0.1:4100";
const get=async(path:string)=>{const response=await fetch(`${api}${path}`);const body=await response.json();assert(response.ok,`${path} failed: ${JSON.stringify(body)}`);return body;};
const post=async(path:string,body:unknown)=>{const response=await fetch(`${api}${path}`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)});const payload=await response.json();assert(response.ok,`${path} failed: ${JSON.stringify(payload)}`);return payload;};

const health=await get("/health");assert.equal(health.marketData.source,"coinbase");
const markets=await get("/v1/markets");
for(const market of ["BTC","ETH"]){const item=markets.markets[market];assert.equal(item.source,"coinbase");assert(BigInt(item.bid)>0n);assert(BigInt(item.ask)>=BigInt(item.bid));assert(Date.now()-item.observedAtMs<3_000,`${market} feed is stale`);}
const small=await post("/v1/quote",{market:"BTC",side:"buy",amount:"100"});
const large=await post("/v1/quote",{market:"BTC",side:"buy",amount:"10000"});
assert(Date.now()-small.observedAtMs<3_000);assert(Date.now()-large.observedAtMs<3_000);assert(BigInt(small.expectedPrice)>=BigInt(small.ask));assert(BigInt(large.expectedPrice)>=BigInt(large.ask));assert(BigInt(large.impactCharge)>=BigInt(small.impactCharge));assert.equal(BigInt(small.fee),20_000n);assert.equal(BigInt(large.fee),2_000_000n);
console.log(`Live market-data smoke passed: Coinbase BTC ${small.bid}/${small.ask}; $100 and $10,000 size-aware RFQs are fresh and internally consistent`);
