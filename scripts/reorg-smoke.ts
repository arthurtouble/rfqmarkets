import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Contract, JsonRpcProvider, NonceManager, Wallet, keccak256, toUtf8Bytes } from "ethers";

const indexer=process.env.RFQ_INDEXER_URL??"http://127.0.0.1:4300";
const deployment=JSON.parse(readFileSync(resolve(".local-state","deployment.json"),"utf8")) as {rpcUrl:string;clearingAddress:string;tokenAddress:string;sponsorPrivateKey:string};
const provider=new JsonRpcProvider(process.env.RFQ_RPC_URL??deployment.rpcUrl);
const sponsor=new NonceManager(new Wallet(deployment.sponsorPrivateKey,provider));
const token=new Contract(deployment.tokenAddress,["function mint(address,uint256)"],sponsor);
const clearing=new Contract(deployment.clearingAddress,["function depositWithAuthorization(address,uint256,uint256,uint256,bytes32,uint8,bytes32,bytes32)"],sponsor);
const user=Wallet.createRandom(),amount=100n*1_000_000n,zero=`0x${"00".repeat(32)}`;

async function rpc(method:string,params:unknown[]=[]){return provider.send(method,params);}
async function mine(count:number){for(let index=0;index<count;index++)await rpc("evm_mine");}
async function get(path:string){const response=await fetch(`${indexer}${path}`);return {response,payload:await response.json()};}

const baseline=(await get("/v1/activity?limit=100")).payload as {items:Array<{tx_hash:string}>};
const baselineHashes=new Set(baseline.items.map(item=>item.tx_hash));
const snapshot=await rpc("evm_snapshot") as string;
let depositHash="";
try{
  await (await token.mint(user.address,amount)).wait();
  const latest=await provider.getBlock("latest");assert(latest);
  const nonce=keccak256(toUtf8Bytes(`reorg:${user.address}`));
  const receipt=await (await clearing.depositWithAuthorization(user.address,amount,latest.timestamp-60,latest.timestamp+600,nonce,27,zero,zero)).wait();assert(receipt);
  depositHash=receipt.hash;
  await mine(2);

  const indexed=await get(`/v1/account/${user.address}`);
  assert.equal(indexed.response.status,200,JSON.stringify(indexed.payload));
  assert.equal((indexed.payload as {collateral:string}).collateral,amount.toString());
  const branchActivity=await get(`/v1/account/${user.address}/activity`);
  assert.equal(branchActivity.response.status,200);
  assert((branchActivity.payload as {items:Array<{tx_hash:string;kind:string}>}).items.some(item=>item.tx_hash===depositHash&&item.kind==="Deposited"));
} finally {
  assert.equal(await rpc("evm_revert",[snapshot]),true,"failed to restore canonical snapshot");
  await mine(3);
}

let rebuilt=await get(`/v1/account/${user.address}`);
for(let attempt=0;attempt<20&&rebuilt.response.status!==404;attempt++){
  await new Promise(resolve=>setTimeout(resolve,100));
  rebuilt=await get(`/v1/account/${user.address}`);
}
assert.equal(rebuilt.response.status,404,"orphaned account survived the reorg rebuild");
const activity=await get("/v1/activity?limit=100");
assert.equal(activity.response.status,200);
const hashes=new Set((activity.payload as {items:Array<{tx_hash:string}>}).items.map(item=>item.tx_hash));
assert(!hashes.has(depositHash),"orphaned deposit survived the reorg rebuild");
for(const hash of baselineHashes)assert(hashes.has(hash),`canonical activity ${hash} disappeared during rebuild`);
const health=await get("/health");
assert.equal(health.response.status,200);assert.equal((health.payload as {ok:boolean}).ok,true,JSON.stringify(health.payload));
console.log(`Reorg smoke passed: orphaned deposit ${depositHash} was removed and ${baselineHashes.size} canonical activity records survived rebuild`);
