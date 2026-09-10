import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Contract, JsonRpcProvider, NonceManager, Wallet, keccak256, toUtf8Bytes } from "ethers";

const indexer=process.env.RFQ_INDEXER_URL??"http://127.0.0.1:4300";
const deployment=JSON.parse(readFileSync(resolve(".local-state","deployment.json"),"utf8")) as {rpcUrl:string;clearingAddress:string;tokenAddress:string};
const provider=new JsonRpcProvider(process.env.RFQ_RPC_URL??deployment.rpcUrl);
// Use a dedicated local-chain signer so the drill cannot race the API sender's nonce.
const writer=new NonceManager(await provider.getSigner(0));
const token=new Contract(deployment.tokenAddress,["function mint(address,uint256)"],writer);
const clearing=new Contract(deployment.clearingAddress,["function depositWithAuthorization(address,uint256,uint256,uint256,bytes32,uint8,bytes32,bytes32)"],writer);
const user=Wallet.createRandom(),amount=100n*1_000_000n,zero=`0x${"00".repeat(32)}`;

async function rpc(method:string,params:unknown[]=[]){return provider.send(method,params);}
async function mine(count:number){for(let index=0;index<count;index++)await rpc("evm_mine");}
async function get(path:string){const response=await fetch(`${indexer}${path}`);return {response,payload:await response.json()};}
async function allActivity(){
  const items:Array<{tx_hash:string}>=[];let cursor:string|null=null;
  do{const suffix=cursor?`&cursor=${encodeURIComponent(cursor)}`:"",result=await get(`/v1/activity?limit=100${suffix}`);assert.equal(result.response.status,200,JSON.stringify(result.payload));const page=result.payload as {items:Array<{tx_hash:string}>;nextCursor:string|null};items.push(...page.items);cursor=page.nextCursor;}while(cursor);
  return items;
}
async function waitCaughtUp(){for(let attempt=0;attempt<100;attempt++){const health=await get("/health");if(health.response.ok&&(health.payload as {ok:boolean;lag:number}).ok&&(health.payload as {lag:number}).lag===0)return;await new Promise(resolve=>setTimeout(resolve,100));}throw new Error("indexer did not catch up");}
async function waitForAccount(address:string){let result=await get(`/v1/account/${address}`);for(let attempt=0;attempt<100&&result.response.status===404;attempt++){await new Promise(resolve=>setTimeout(resolve,100));result=await get(`/v1/account/${address}`);}return result;}

await waitCaughtUp();
const baselineHashes=new Set((await allActivity()).map(item=>item.tx_hash));
const baselineRiskRaw=(await get("/v1/risk?finalized=true")).payload as {accountCount:number;totalCollateral:string};const baselineRisk={accountCount:baselineRiskRaw.accountCount,totalCollateral:baselineRiskRaw.totalCollateral};
const snapshot=await rpc("evm_snapshot") as string;
let depositHash="";
try{
  await (await token.mint(user.address,amount)).wait();
  const latest=await provider.getBlock("latest");assert(latest);
  const nonce=keccak256(toUtf8Bytes(`reorg:${user.address}`));
  const receipt=await (await clearing.depositWithAuthorization(user.address,amount,latest.timestamp-60,latest.timestamp+600,nonce,27,zero,zero)).wait();assert(receipt);
  depositHash=receipt.hash;
  await mine(2);
  await waitCaughtUp();

  const indexed=await waitForAccount(user.address);
  assert.equal(indexed.response.status,200,JSON.stringify(indexed.payload));
  assert.equal((indexed.payload as {collateral:string}).collateral,amount.toString());
  const branchActivity=await get(`/v1/account/${user.address}/activity`);
  assert.equal(branchActivity.response.status,200);
  assert((branchActivity.payload as {items:Array<{tx_hash:string;kind:string}>}).items.some(item=>item.tx_hash===depositHash&&item.kind==="Deposited"));
  const branchRisk=await get("/v1/risk?finalized=true");assert.equal(branchRisk.response.status,200);assert.equal(branchRisk.payload.accountCount,baselineRisk.accountCount+1,"finalized projection missed branch account");assert.equal(BigInt(branchRisk.payload.totalCollateral),BigInt(baselineRisk.totalCollateral)+amount,"finalized projection missed branch collateral");
} finally {
  assert.equal(await rpc("evm_revert",[snapshot]),true,"failed to restore canonical snapshot");
  await mine(3);
}

let rebuilt=await get(`/v1/account/${user.address}`);
for(let attempt=0;attempt<100&&rebuilt.response.status!==404;attempt++){
  await new Promise(resolve=>setTimeout(resolve,100));
  rebuilt=await get(`/v1/account/${user.address}`);
}
assert.equal(rebuilt.response.status,404,"orphaned account survived the reorg rebuild");
await waitCaughtUp();
const hashes=new Set((await allActivity()).map(item=>item.tx_hash));
assert(!hashes.has(depositHash),"orphaned deposit survived the reorg rebuild");
for(const hash of baselineHashes)assert(hashes.has(hash),`canonical activity ${hash} disappeared during rebuild`);
const rebuiltRisk=await get("/v1/risk?finalized=true");assert.deepEqual({accountCount:rebuiltRisk.payload.accountCount,totalCollateral:rebuiltRisk.payload.totalCollateral},baselineRisk,"finalized risk projection retained orphaned state");
const rebuiltPositions=await get("/v1/positions?finalized=true&limit=100");assert(!(rebuiltPositions.payload as {items:Array<{account:string}>}).items.some(item=>item.account.toLowerCase()===user.address.toLowerCase()),"finalized positions retained orphaned account");
const health=await get("/health");
assert.equal(health.response.status,200);assert.equal((health.payload as {ok:boolean}).ok,true,JSON.stringify(health.payload));
console.log(`Reorg smoke passed: orphaned deposit ${depositHash} was removed and ${baselineHashes.size} canonical activity records survived rebuild`);
