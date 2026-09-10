import assert from "node:assert/strict";
import { buildApi } from "../services/api/src/server.js";

const requests=Number(process.env.RFQ_LOAD_REQUESTS??10_000),capacity=Number(process.env.RFQ_LOAD_CAPACITY??5_000),concurrency=Number(process.env.RFQ_LOAD_CONCURRENCY??250);
// This drill targets portfolio/capacity behavior. Admission throttling has a
// separate deterministic test, so raise its budget above this synthetic burst.
const api=buildApi({maxActiveQuotes:capacity,firmQuoteRatePerSecond:requests,firmQuoteBurst:requests+1,globalFirmQuoteRatePerSecond:requests,globalFirmQuoteBurst:requests+1});await api.ready();
let accepted=0,rejected=0,unexpected=0,next=0;const started=performance.now();
async function worker(){for(;;){const index=next++;if(index>=requests)return;const response=await api.inject({method:"POST",url:"/v1/quote",payload:{market:index%2?"BTC":"ETH",side:index%4<2?"buy":"sell",amount:String(100+(index%10_000))}});if(response.statusCode===200)accepted++;else if(response.statusCode===409&&response.body.includes("capacity"))rejected++;else unexpected++;}}
await Promise.all(Array.from({length:Math.min(concurrency,requests)},worker));
const malformed=await api.inject({method:"POST",url:"/v1/quote",payload:{market:"BTC",side:"buy",amount:"1e999999"}});
await api.close();
assert.equal(accepted,Math.min(requests,capacity));assert.equal(rejected,Math.max(0,requests-capacity));assert.equal(unexpected,0);assert.equal(malformed.statusCode,400);
console.log(JSON.stringify({requests,concurrency,accepted,rejected,unexpected,elapsedMs:Math.round(performance.now()-started),requestsPerSecond:Math.round(requests/((performance.now()-started)/1_000))},null,2));
