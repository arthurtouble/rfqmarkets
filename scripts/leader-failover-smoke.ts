import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Contract, JsonRpcProvider, Wallet } from "ethers";

const api=process.env.RFQ_API_URL??"http://127.0.0.1:4100";
const deployment=JSON.parse(readFileSync(resolve(".local-state","deployment.json"),"utf8")) as {rpcUrl:string;clearingAddress:string};
const provider=new JsonRpcProvider(process.env.RFQ_RPC_URL??deployment.rpcUrl);
const council=await provider.getSigner(0);
const clearing=new Contract(deployment.clearingAddress,["function leaderEpoch() view returns(uint64)","function advanceLeaderEpoch(uint64)"],council);
const user=Wallet.createRandom();
const post=async(path:string,body:unknown)=>{const response=await fetch(`${api}${path}`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)});return {response,payload:await response.json()};};
const prepare=async()=>{
  const quoted=await post("/v1/quote",{market:"ETH",side:"buy",amount:"250"});assert(quoted.response.ok,JSON.stringify(quoted.payload));
  const nonce=BigInt(`0x${crypto.randomUUID().replaceAll("-","")}`).toString();
  const prepared=await post("/v1/prepare",{quoteId:quoted.payload.quoteId,account:user.address,nonce});assert(prepared.response.ok,JSON.stringify(prepared.payload));
  const signature=await user.signTypedData(prepared.payload.domain,prepared.payload.types,prepared.payload.intent);
  return {quoteId:quoted.payload.quoteId,nonce,prepared:prepared.payload,signature};
};

const deposit=await post("/v1/deposit/quote",{account:user.address,fromChainId:1,fromToken:"USDC",amount:"3000"});assert(deposit.response.ok,JSON.stringify(deposit.payload));
const depositSignature=await user.signTypedData(deposit.payload.domain,deposit.payload.types,deposit.payload.intent);
const funded=await post("/v1/deposit/execute",{routeId:deposit.payload.routeId,userSignature:depositSignature});assert(funded.response.ok,JSON.stringify(funded.payload));
const old=await prepare(),expected=BigInt(await clearing.leaderEpoch());
await (await clearing.advanceLeaderEpoch(expected)).wait();
assert.equal(BigInt(await clearing.leaderEpoch()),expected+1n);
const fenced=await post("/v1/approve",{quoteId:old.quoteId,account:user.address,nonce:old.nonce,userSignature:old.signature});
assert(!fenced.response.ok,"old-epoch intent unexpectedly survived promotion");

const fresh=await prepare();
assert.equal(BigInt(fresh.prepared.intent.leaderEpoch),expected+1n);
const included=await post("/v1/approve",{quoteId:fresh.quoteId,account:user.address,nonce:fresh.nonce,userSignature:fresh.signature});
assert(included.response.ok,JSON.stringify(included.payload));
assert.match(included.payload.transaction?.hash??"",/^0x[0-9a-fA-F]{64}$/);
console.log(`Leader failover smoke passed: epoch ${expected} fenced and epoch ${expected+1n} settled ${included.payload.transaction.hash}`);
