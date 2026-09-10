import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Wallet } from "ethers";
import { buildApprover } from "../services/approver/src/server.js";
import { buildApi } from "../services/api/src/server.js";
import { PythHermesSource } from "../services/api/src/oracle.js";
import { loadDeploymentConfig } from "./deployment-config.js";

type Identity={address:string;privateKey:string};type Manifest={chainId:string;contracts:{clearingProxy:string;usdc:string};feedIds:[string,string]};
process.env.NODE_ENV="test";const key=process.env.PYTH_API_KEY;if(!key)throw new Error("missing PYTH_API_KEY");const config=loadDeploymentConfig(process.env);if(config.oracleMode!=="pyth")throw new Error("deployment is not configured for Pyth");
const manifest=JSON.parse(readFileSync(resolve(process.env.RFQ_BASE_SEPOLIA_DEPLOYMENT_FILE??".local-state/base-sepolia-deployment.json"),"utf8")) as Manifest,identities=JSON.parse(readFileSync(resolve(".local-state/testnet-identities.json"),"utf8")) as {sponsor:Identity;approvers:Identity[]},directory=mkdtempSync(join(tmpdir(),"rfq-pyth-e2e-")),apps:Array<{close():Promise<void>}>=[],approvers:Array<{url:string;token:string}>=[];
try{
  const approverRpc="https://base-sepolia-rpc.publicnode.com";
  for(let index=0;index<3;index++){const token=`smoke-${index}-${crypto.randomUUID()}`,app=buildApprover({privateKey:identities.approvers[index].privateKey,transportToken:token,databasePath:join(directory,`approver-${index}.sqlite`),expectedChainId:BigInt(manifest.chainId),expectedVerifyingContract:manifest.contracts.clearingProxy,rpcUrl:approverRpc,secondaryRpcUrl:config.rpcUrl,oracleMode:"pyth"});const url=await app.listen({host:"127.0.0.1",port:0});apps.push(app);approvers.push({url,token});}
  const source=new PythHermesSource({apiKey:key,feedIds:{BTC:manifest.feedIds[0],ETH:manifest.feedIds[1]}}),api=buildApi({approvers,chainId:BigInt(manifest.chainId),verifyingContract:manifest.contracts.clearingProxy,journalPath:join(directory,"api.sqlite"),oracleSource:source,chain:{rpcUrl:config.rpcUrl,sponsorPrivateKey:identities.sponsor.privateKey,clearingAddress:manifest.contracts.clearingProxy,tokenAddress:manifest.contracts.usdc}});await api.ready();apps.push(api);
  const post=async(path:string,body:Record<string,unknown>)=>{const response=await api.inject({method:"POST",url:path,payload:body});const payload=response.json();assert.equal(response.statusCode,200,`${path}: ${JSON.stringify(payload)}`);return payload;};
  const quote=await post("/v1/quote",{market:"BTC",side:"buy",amount:"1"}),nonce=BigInt(`0x${crypto.randomUUID().replaceAll("-","")}`).toString(),prepared=await post("/v1/prepare",{quoteId:quote.quoteId,account:identities.sponsor.address,nonce}),wallet=new Wallet(identities.sponsor.privateKey),signature=await wallet.signTypedData(prepared.domain,prepared.types,prepared.intent),executed=await post("/v1/approve",{quoteId:quote.quoteId,account:wallet.address,nonce,userSignature:signature});
  assert.equal(new Set(executed.approvals.map((item:{signer:string})=>item.signer.toLowerCase())).size,2);assert.match(executed.transaction.hash,/^0x[0-9a-f]{64}$/i);console.log(JSON.stringify({verified:true,market:"BTC",notionalUsdc:"1",approvalQuorum:2,transactionHash:executed.transaction.hash,blockNumber:executed.transaction.blockNumber,oracle:source.status()},null,2));
}finally{await Promise.allSettled(apps.reverse().map(app=>app.close()));}
