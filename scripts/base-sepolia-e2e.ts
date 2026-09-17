import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Contract, JsonRpcProvider, Wallet } from "ethers";
import { buildApprover } from "../services/approver/src/server.js";
import { buildApi } from "../services/api/src/server.js";
import { PythHermesSource } from "../services/api/src/oracle.js";
import { loadDeploymentConfig } from "./deployment-config.js";
import { btcRetryDelay, QualificationResponseError, retryQualification, transientReadError } from "./qualification-retry.js";

type Identity={address:string;privateKey:string};
type Manifest={chainId:string;contracts:{clearingProxy:string;usdc:string};feedIds:[string,string]};
type Injectable={inject(options:{method:string;url:string;payload?:unknown}):Promise<{statusCode:number;json():any}>;close():Promise<void>};

process.env.NODE_ENV="test";
const key=process.env.PYTH_API_KEY;
if(!key)throw new Error("missing PYTH_API_KEY");
const config=loadDeploymentConfig(process.env);
if(config.oracleMode!=="pyth")throw new Error("deployment is not configured for Pyth");
const approverTimeoutMs=Number(process.env.RFQ_APPROVER_TIMEOUT_MS??5_000);
if(!Number.isInteger(approverTimeoutMs)||approverTimeoutMs<1_000||approverTimeoutMs>30_000)throw new Error("invalid approver timeout");
const manifest=JSON.parse(readFileSync(resolve(process.env.RFQ_BASE_SEPOLIA_DEPLOYMENT_FILE??".local-state/base-sepolia-deployment.json"),"utf8")) as Manifest;
const identities=JSON.parse(readFileSync(resolve(".local-state/testnet-identities.json"),"utf8")) as {sponsor:Identity;approvers:Identity[]};
const directory=mkdtempSync(join(tmpdir(),"rfq-pyth-e2e-")),apps:Array<{close():Promise<void>}>=[],approvers:Array<{url:string;token:string}>=[];
const wallet=new Wallet(identities.sponsor.privateKey);
let api:Injectable|undefined;
const positionProvider=new JsonRpcProvider(config.rpcUrl,undefined,{batchMaxCount:1});
const positionContract=new Contract(manifest.contracts.clearingProxy,["function positionOf(address,uint8) view returns(int256 size,uint256 entryPrice,int256 lastFundingIndex)"],positionProvider);

async function request(path:string,body?:Record<string,unknown>){
  assert(api,"API unavailable");
  const response=await api.inject({method:body?"POST":"GET",url:path,payload:body});
  return {response,payload:response.json()};
}
async function post(path:string,body:Record<string,unknown>){
  const {response,payload}=await request(path,body);
  if(response.statusCode!==200)throw new QualificationResponseError(path,response.statusCode,payload);
  return payload;
}
async function btcSize(){
  return retryQualification(async()=>BigInt((await positionContract.positionOf(wallet.address,0)).size),error=>transientReadError(error)?5_000:null);
}
async function waitForBtc(open:boolean){
  for(let attempt=0;attempt<20;attempt++){
    const size=await btcSize();
    if((size!==0n)===open)return size;
    await new Promise(resolve=>setTimeout(resolve,500));
  }
  throw new Error(`BTC position did not become ${open?"open":"flat"} within 10 seconds`);
}
async function closeBtc(){
  if(await btcSize()===0n)return undefined;
  return retryQualification(async()=>{
    const quote=await post("/v1/close/quote",{account:wallet.address,market:"BTC"}),nonce=BigInt(`0x${crypto.randomUUID().replaceAll("-","")}`).toString(),prepared=await post("/v1/prepare",{quoteId:quote.quoteId,account:wallet.address,nonce,reduceOnly:true}),userSignature=await wallet.signTypedData(prepared.domain,prepared.types,prepared.intent),closed=await post("/v1/approve",{quoteId:quote.quoteId,account:wallet.address,nonce,userSignature});
    await waitForBtc(false);return closed;
  },btcRetryDelay);
}
async function openBtc(){return retryQualification(async()=>{
  const quote=await post("/v1/quote",{market:"BTC",side:"buy",amount:"1"}),nonce=BigInt(`0x${crypto.randomUUID().replaceAll("-","")}`).toString(),prepared=await post("/v1/prepare",{quoteId:quote.quoteId,account:wallet.address,nonce}),signature=await wallet.signTypedData(prepared.domain,prepared.types,prepared.intent),executed=await post("/v1/approve",{quoteId:quote.quoteId,account:wallet.address,nonce,userSignature:signature});await waitForBtc(true);return executed;
 },btcRetryDelay);
}

try{
  const approverRpc="https://base-sepolia-rpc.publicnode.com";
  for(let index=0;index<3;index++){
    const token=`smoke-${index}-${crypto.randomUUID()}`;
    const app=buildApprover({privateKey:identities.approvers[index].privateKey,transportToken:token,databasePath:join(directory,`approver-${index}.sqlite`),expectedChainId:BigInt(manifest.chainId),expectedVerifyingContract:manifest.contracts.clearingProxy,rpcUrl:approverRpc,secondaryRpcUrl:config.rpcUrl,oracleMode:"pyth"});
    const url=await app.listen({host:"127.0.0.1",port:0});apps.push(app);approvers.push({url,token});
  }
  const source=new PythHermesSource({apiKey:key,feedIds:{BTC:manifest.feedIds[0],ETH:manifest.feedIds[1]}});
  api=buildApi({approvers,approverTimeoutMs,chainId:BigInt(manifest.chainId),verifyingContract:manifest.contracts.clearingProxy,journalPath:join(directory,"api.sqlite"),oracleSource:source,chain:{rpcUrl:config.rpcUrl,sponsorPrivateKey:identities.sponsor.privateKey,clearingAddress:manifest.contracts.clearingProxy,tokenAddress:manifest.contracts.usdc}}) as Injectable;
  await (api as any).ready();apps.push(api);

  const recovered=await closeBtc();
  const executed=await openBtc();
  assert.equal(new Set(executed.approvals.map((item:{signer:string})=>item.signer.toLowerCase())).size,2);
  assert.match(executed.transaction.hash,/^0x[0-9a-f]{64}$/i);
  const closed=await closeBtc();
  assert.equal(await btcSize(),0n,"BTC canary left customer exposure open");
  console.log(JSON.stringify({verified:true,market:"BTC",notionalUsdc:"1",approvalQuorum:2,recoveredPriorPosition:recovered?.transaction?.hash,openTransactionHash:executed.transaction.hash,closeTransactionHash:closed?.transaction?.hash,blockNumber:closed?.transaction?.blockNumber,finalBase:"0",oracle:source.status()},null,2));
}finally{
  if(api)await closeBtc().catch(error=>console.error(`cleanup failed: ${String(error)}`));
  await Promise.allSettled(apps.reverse().map(app=>app.close()));
  positionProvider.destroy();
}
