import assert from "node:assert/strict";
import { Wallet } from "ethers";
import {expectPostJson,randomNonce,sleep} from "./lib/http.js";

const api=process.env.RFQ_API_URL??"http://127.0.0.1:4100";
const indexer=process.env.RFQ_INDEXER_URL??"http://127.0.0.1:4300";
const hedger=process.env.RFQ_HEDGER_URL??"http://127.0.0.1:4400";
const hedgeToken=process.env.RFQ_HEDGE_OPS_TOKEN??"local-development-hedge-token";
const rpc=process.env.RFQ_RPC_URL??"http://127.0.0.1:8545";
const user=Wallet.createRandom();
const post=(path:string,body:unknown)=>expectPostJson(api,path,body);
const depositQuote=await post("/v1/deposit/quote",{account:user.address,fromChainId:1,fromToken:"ETH",amount:"1"});
const depositSignature=await user.signTypedData(depositQuote.domain,depositQuote.types,depositQuote.intent);
const deposited=await post("/v1/deposit/execute",{routeId:depositQuote.routeId,userSignature:depositSignature});
assert.match(deposited.transaction?.hash??"",/^0x[0-9a-fA-F]{64}$/);
assert(BigInt(deposited.transaction.collateral)>=BigInt(depositQuote.minimumUsdc));
const withdrawalNonce=randomNonce();
const withdrawal=await post("/v1/withdraw/prepare",{account:user.address,amount:"10",nonce:withdrawalNonce});
const withdrawalSignature=await user.signTypedData(withdrawal.domain,withdrawal.types,withdrawal.intent);
const withdrawn=await post("/v1/withdraw/execute",{intent:withdrawal.intent,userSignature:withdrawalSignature});assert.match(withdrawn.transaction?.hash??"",/^0x[0-9a-fA-F]{64}$/);
const cancelNonce=randomNonce();
const cancellation=await post("/v1/nonce/cancel/prepare",{account:user.address,nonce:cancelNonce});
const cancellationSignature=await user.signTypedData(cancellation.domain,cancellation.types,cancellation.intent);
const cancelled=await post("/v1/nonce/cancel/execute",{intent:cancellation.intent,userSignature:cancellationSignature});assert.match(cancelled.transaction?.hash??"",/^0x[0-9a-fA-F]{64}$/);
const session=Wallet.createRandom(),sessionNonce=randomNonce();
const grant=await post("/v1/session/prepare",{account:user.address,session:session.address,marketMask:3,maxTradeAmount:"2500",maxCumulativeAmount:"10000",maxFee:"5",durationSeconds:28_800,nonce:sessionNonce});
const grantSignature=await user.signTypedData(grant.domain,grant.types,grant.grant);
const activated=await post("/v1/session/execute",{grant:grant.grant,userSignature:grantSignature});assert.equal(activated.status,"active");
const quote=await post("/v1/quote",{market:"BTC",side:"buy",amount:"1000"});
const nonce=randomNonce();
const prepared=await post("/v1/prepare",{quoteId:quote.quoteId,account:user.address,nonce});
const userSignature=await session.signTypedData(prepared.domain,prepared.types,prepared.intent);
const approved=await post("/v1/approve",{quoteId:quote.quoteId,account:user.address,nonce,userSignature});
assert.equal(new Set(approved.approvals.map((item:{signer:string})=>item.signer.toLowerCase())).size,2);
assert.match(approved.transaction?.hash??"",/^0x[0-9a-fA-F]{64}$/);
assert.equal(approved.transaction.position.size,prepared.intent.baseDelta);
assert(BigInt(approved.transaction.collateral)>0n);
let indexed:{collateral:string;positions:{BTC:{size:string}}}|undefined;
for(let attempt=0;attempt<20;attempt++){const response=await fetch(`${indexer}/v1/account/${user.address}`);if(response.ok){indexed=await response.json();if(indexed?.positions.BTC.size===prepared.intent.baseDelta)break;}await sleep(250);}
assert(indexed,"account was not indexed");assert.equal(indexed.positions.BTC.size,prepared.intent.baseDelta);assert.equal(indexed.collateral,approved.transaction.collateral);
const activityResponse=await fetch(`${indexer}/v1/account/${user.address}/activity`);assert(activityResponse.ok);const activity=await activityResponse.json();assert(activity.items.some((item:{kind:string})=>item.kind==="TradeExecuted"));assert(activity.items.some((item:{kind:string})=>item.kind==="Deposited"));
for(let id=1;id<=2;id++){const mined=await fetch(rpc,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({jsonrpc:"2.0",id,method:"evm_mine",params:[]})});assert(mined.ok);}
let positions:{finality:string;items:Array<{account:string}>}|undefined;
for(let attempt=0;attempt<20;attempt++){const response=await fetch(`${indexer}/v1/positions?finalized=true&limit=100`);assert(response.ok);positions=await response.json();if(positions?.items.some(item=>item.account.toLowerCase()===user.address.toLowerCase()))break;await sleep(250);}
assert.equal(positions?.finality,"finalized");assert(positions.items.some(item=>item.account.toLowerCase()===user.address.toLowerCase()));
const publicTradesResponse=await fetch(`${indexer}/v1/activity?kind=TradeExecuted&finalized=true&limit=100`);assert(publicTradesResponse.ok);const publicTrades=await publicTradesResponse.json();assert(publicTrades.items.every((item:{kind:string;finality:string})=>item.kind==="TradeExecuted"&&item.finality==="finalized"));
const hedgeResponse=await fetch(`${hedger}/v1/tick`,{method:"POST",headers:{authorization:`Bearer ${hedgeToken}`}});assert(hedgeResponse.ok);
console.log(`Live RFQ smoke passed: deposit, withdrawal, cancellation and scoped session; 2-of-3 popup-free fill ${approved.transaction.hash} at block ${approved.transaction.blockNumber}; public indexer and hedge reconciliation complete`);
