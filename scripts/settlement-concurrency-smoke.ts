import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Contract, JsonRpcProvider, Wallet } from "ethers";

const api=process.env.RFQ_API_URL??"http://127.0.0.1:4100",count=Number(process.env.RFQ_SETTLEMENT_CLIENTS??24);
const deployment=JSON.parse(readFileSync(".local-state/deployment.json","utf8")) as {rpcUrl:string;clearingAddress:string;tokenAddress:string};
const provider=new JsonRpcProvider(deployment.rpcUrl),clearingArtifact=JSON.parse(readFileSync("artifacts/RFQClearing.json","utf8")),tokenArtifact=JSON.parse(readFileSync("artifacts/MockUSDC.json","utf8"));
const clearing=new Contract(deployment.clearingAddress,clearingArtifact.abi,provider),token=new Contract(deployment.tokenAddress,tokenArtifact.abi,provider);
const nonce=()=>BigInt(`0x${crypto.randomUUID().replaceAll("-","")}`).toString();
async function post(path:string,body:unknown){const response=await fetch(`${api}${path}`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)}),payload=await response.json();return {response,payload};}

const startingAggregate=[BigInt((await clearing.markets(0)).aggregateBase),BigInt((await clearing.markets(1)).aggregateBase)];
const clients=Array.from({length:count},(_,index)=>({wallet:Wallet.createRandom(),market:index%2===0?"BTC":"ETH",side:index%4<2?"buy":"sell",amount:String(100+(index%5)*25),nonce:nonce()}));
// Fund accounts before the latency-sensitive trade phase. Local auto-funding is
// intentionally implemented as two extra sponsored transactions and would test
// fixture setup throughput rather than settlement throughput here.
for(const client of clients){
  const deposit=await post("/v1/dev/fund",{account:client.wallet.address,amount:"2500"});assert(deposit.response.ok,JSON.stringify(deposit.payload));
}
// Quotes allow 1% slippage so the check isolates concurrency from simulated price drift.
const prepared=await Promise.all(clients.map(async client=>{
  const quote=await post("/v1/quote",{market:client.market,side:client.side,amount:client.amount,slippageBps:100});assert(quote.response.ok,JSON.stringify(quote.payload));
  const intent=await post("/v1/prepare",{quoteId:quote.payload.quoteId,account:client.wallet.address,nonce:client.nonce});assert(intent.response.ok,JSON.stringify(intent.payload));
  const signature=await client.wallet.signTypedData(intent.payload.domain,intent.payload.types,intent.payload.intent);
  return {...client,quoteId:quote.payload.quoteId,intent:intent.payload.intent,payload:{quoteId:quote.payload.quoteId,account:client.wallet.address,nonce:client.nonce,userSignature:signature}};
}));
const started=Date.now(),results=await Promise.all(prepared.map(async item=>({...item,result:await post("/v1/approve",item.payload)}))),elapsed=Date.now()-started;
const accepted=results.filter(item=>item.result.response.ok),rejected=results.filter(item=>!item.result.response.ok);
for(const item of rejected){assert([409,503].includes(item.result.response.status),JSON.stringify(item.result.payload));assert.match(String(item.result.payload.error),/price moved|chain submission|inclusion|quorum|settlement|admission inventory changed|approval risk changed/);}
assert(accepted.length>=Math.floor(count*0.75),`only ${accepted.length}/${count} parallel settlements succeeded: ${JSON.stringify(rejected.map(item=>item.result.payload))}`);
assert.equal(new Set(accepted.map(item=>item.result.payload.transaction.hash)).size,accepted.length,"two settlements reported the same transaction");
for(const item of accepted){assert.equal(await clearing.nonceUsed(item.wallet.address,item.nonce),true);const position=await clearing.positionOf(item.wallet.address,item.market==="BTC"?0:1);assert.equal(position.size.toString(),item.intent.baseDelta);}

// An idempotent client retry must return the original result without consuming
// another sponsor nonce or producing another transaction.
const retry=await post("/v1/approve",accepted[0].payload);assert(retry.response.ok,JSON.stringify(retry.payload));assert.equal(retry.payload.transaction.hash,accepted[0].result.payload.transaction.hash);

const closed=await Promise.all(accepted.map(async item=>{
  for(let attempt=0;attempt<4;attempt++){
    const closeQuote=await post("/v1/close/quote",{account:item.wallet.address,market:item.market});assert(closeQuote.response.ok,JSON.stringify(closeQuote.payload));
    const closeNonce=nonce(),preparedClose=await post("/v1/prepare",{quoteId:closeQuote.payload.quoteId,account:item.wallet.address,nonce:closeNonce,reduceOnly:true});assert(preparedClose.response.ok,JSON.stringify(preparedClose.payload));
    const signature=await item.wallet.signTypedData(preparedClose.payload.domain,preparedClose.payload.types,preparedClose.payload.intent),result=await post("/v1/approve",{quoteId:closeQuote.payload.quoteId,account:item.wallet.address,nonce:closeNonce,reduceOnly:true,userSignature:signature});
    if(result.response.ok)return {...item,closeNonce,result};
    assert.match(String(result.payload.error),/price moved|chain submission|inclusion|settlement|admission inventory changed|approval risk changed/);
  }
  throw new Error(`close retries exhausted for ${item.wallet.address}`);
}));
for(const item of closed){assert.equal((await clearing.positionOf(item.wallet.address,item.market==="BTC"?0:1)).size,0n);assert.equal(await clearing.nonceUsed(item.wallet.address,item.closeNonce),true);}
for(let market=0;market<2;market++)assert.equal(BigInt((await clearing.markets(market)).aggregateBase),startingAggregate[market],`market ${market} did not return to its starting exposure`);
const internal=BigInt(await clearing.makerBacking())+BigInt(await clearing.insuranceBalance())+BigInt(await clearing.totalCustomerCollateral());assert.equal(await token.balanceOf(deployment.clearingAddress),internal,"custody buckets diverged after concurrent settlement and close");
console.log(`Concurrent settlement passed: ${accepted.length}/${count} admitted and included in ${elapsed}ms; ${rejected.length} safely rejected; idempotent retry, parallel close, nonce, exposure, and custody checks passed`);
