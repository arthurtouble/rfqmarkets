import assert from "node:assert/strict";
import { Wallet } from "ethers";

const api=process.env.RFQ_API_URL??"http://127.0.0.1:4100";
const indexer=process.env.RFQ_INDEXER_URL??"http://127.0.0.1:4300";
const hedger=process.env.RFQ_HEDGER_URL??"http://127.0.0.1:4400";
const user=Wallet.createRandom();
const post=async(path:string,body:unknown)=>{
  const response=await fetch(`${api}${path}`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)});
  const payload=await response.json();
  assert(response.ok,`${path} failed: ${JSON.stringify(payload)}`); return payload;
};
const depositQuote=await post("/v1/deposit/quote",{account:user.address,fromChainId:1,fromToken:"ETH",amount:"1"});
const depositSignature=await user.signTypedData(depositQuote.domain,depositQuote.types,depositQuote.intent);
const deposited=await post("/v1/deposit/execute",{routeId:depositQuote.routeId,userSignature:depositSignature});
assert.match(deposited.transaction?.hash??"",/^0x[0-9a-fA-F]{64}$/);
assert(BigInt(deposited.transaction.collateral)>=BigInt(depositQuote.minimumUsdc));
const quote=await post("/v1/quote",{market:"BTC",side:"buy",amount:"1000"});
const nonce=BigInt(`0x${crypto.randomUUID().replaceAll("-","")}`).toString();
const prepared=await post("/v1/prepare",{quoteId:quote.quoteId,account:user.address,nonce});
const userSignature=await user.signTypedData(prepared.domain,prepared.types,prepared.intent);
const approved=await post("/v1/approve",{quoteId:quote.quoteId,account:user.address,nonce,userSignature});
assert.equal(new Set(approved.approvals.map((item:{signer:string})=>item.signer.toLowerCase())).size,2);
assert.match(approved.transaction?.hash??"",/^0x[0-9a-fA-F]{64}$/);
assert.equal(approved.transaction.position.size,prepared.intent.baseDelta);
assert(BigInt(approved.transaction.collateral)>0n);
let indexed:{collateral:string;positions:{BTC:{size:string}}}|undefined;
for(let attempt=0;attempt<20;attempt++){const response=await fetch(`${indexer}/v1/account/${user.address}`);if(response.ok){indexed=await response.json();if(indexed?.positions.BTC.size===prepared.intent.baseDelta)break;}await new Promise(resolve=>setTimeout(resolve,250));}
assert(indexed,"account was not indexed");assert.equal(indexed.positions.BTC.size,prepared.intent.baseDelta);assert.equal(indexed.collateral,approved.transaction.collateral);
const activityResponse=await fetch(`${indexer}/v1/account/${user.address}/activity`);assert(activityResponse.ok);const activity=await activityResponse.json();assert(activity.items.some((item:{kind:string})=>item.kind==="TradeExecuted"));assert(activity.items.some((item:{kind:string})=>item.kind==="Deposited"));
const hedgeResponse=await fetch(`${hedger}/v1/tick`,{method:"POST"});assert(hedgeResponse.ok);
console.log(`Live RFQ smoke passed: routed deposit ${deposited.transaction.hash}; 2-of-3 sponsored fill ${approved.transaction.hash} at block ${approved.transaction.blockNumber}; indexer and hedge reconciliation complete`);
