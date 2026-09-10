import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Wallet } from "ethers";

const deployment=JSON.parse(readFileSync(resolve(".local-state","deployment.json"),"utf8")),state=resolve(".local-state",deployment.deploymentId??"legacy-runtime"),api=process.env.RFQ_API_URL??"http://127.0.0.1:4100";
const pids=[0,1,2].map(index=>Number(readFileSync(resolve(state,`approver-${index}.pid`),"utf8")));
const post=async(path:string,body:unknown)=>{const response=await fetch(`${api}${path}`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)});return {response,payload:await response.json()};};
async function signedApproval(amount:string){const user=Wallet.createRandom(),quote=await post("/v1/quote",{market:"BTC",side:"buy",amount});assert(quote.response.ok,JSON.stringify(quote.payload));const nonce=BigInt(`0x${crypto.randomUUID().replaceAll("-","")}`).toString(),prepared=await post("/v1/prepare",{quoteId:quote.payload.quoteId,account:user.address,nonce});assert(prepared.response.ok,JSON.stringify(prepared.payload));const signature=await user.signTypedData(prepared.payload.domain,prepared.payload.types,prepared.payload.intent);return post("/v1/approve",{quoteId:quote.payload.quoteId,account:user.address,nonce,userSignature:signature});}
const signal=(indexes:number[],name:"SIGSTOP"|"SIGCONT")=>indexes.forEach(index=>process.kill(pids[index],name));
try{
  signal([0],"SIGSTOP");const degraded=await signedApproval("500");assert(degraded.response.ok,`one signer outage lost quorum: ${JSON.stringify(degraded.payload)}`);assert.equal(new Set(degraded.payload.approvals.map((item:{signer:string})=>item.signer.toLowerCase())).size,2);
  signal([1],"SIGSTOP");const unavailable=await signedApproval("400");assert.equal(unavailable.response.status,503,"two signer outage must stop approval");assert.equal(unavailable.payload.error,"approver quorum unavailable");
  console.log(`Approver outage smoke passed: PID ${pids[0]} stopped while two signers settled; stopping PID ${pids[1]} removed quorum safely`);
}finally{signal([0,1,2],"SIGCONT");}
