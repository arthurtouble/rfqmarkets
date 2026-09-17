import assert from "node:assert/strict";
import {test} from "node:test";
import {mkdtempSync,rmSync,writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {collectOperationalSnapshot} from "./operational-snapshot.js";

test("operational collector produces the complete alert input without retaining credentials",async()=>{
  const directory=mkdtempSync(join(tmpdir(),"rfq-ops-")),roles=["api","approver","approver","approver","indexer","hedger","keeper"] as const,manifests=roles.map((role,index)=>{const path=join(directory,`${index}.json`),writerAddress=role==="indexer"?undefined:`0x${String(index+2).padStart(40,"0")}`;writeFileSync(path,JSON.stringify({version:2,createdAt:new Date(10_000+index*1_000).toISOString(),sha256:String(index).repeat(64),sizeBytes:100,context:{version:1,environment:"base-sepolia",chainId:"84532",clearingAddress:"0x0000000000000000000000000000000000000001",role,writerAddress,candidateHash:"a".repeat(64)}}));return path;});
  const payloads:Record<string,unknown>={
    "/health:api":{ok:true,marketData:{agesMs:{BTC:1000,ETH:1500}}},"/internal/metrics:api":{sender:[{status:"included"},{status:"ambiguous"}],quorum:{invalidResponses:2},latency:{tradeApproval:{p95Ms:700}}},
    "/health:indexer":{ok:true,lag:2},"/internal/metrics:keeper":{ok:true,lastCompletedAt:9_500},"/v1/status:hedger":{healthy:true,markets:{BTC:{gapNotional:"30",bandUsdc:"100"},ETH:{gapNotional:"50",bandUsdc:"100"}}},"/health:a":{ok:true},"/health:b":{ok:true},"/health:c":{ok:false},
  };
  const fetchImpl=(async(input,init)=>{const parsed=new URL(String(input)),headers=init?.headers as Record<string,string>|undefined,protectedRoute=parsed.pathname==="/internal/metrics"||parsed.pathname==="/v1/status";assert.equal(Boolean(headers?.authorization),protectedRoute);if(protectedRoute){assert.equal(headers?.authorization,"Bearer secret");}const host=parsed.hostname.split(".")[0],key=`${parsed.pathname}:${host}`;return Response.json(payloads[key]??payloads[`${parsed.pathname}:api`]);}) as typeof fetch;
  const config={version:1,apiUrl:"https://api.example",indexerUrl:"https://indexer.example",keeperUrl:"https://keeper.example",hedgerUrl:"https://hedger.example",approverUrls:["https://a.example","https://b.example","https://c.example"],rpcUrl:"https://rpc.example",clearingAddress:"0x0000000000000000000000000000000000000001",sponsorAddresses:["0x0000000000000000000000000000000000000002","0x0000000000000000000000000000000000000003"],sponsorBurnWeiPerHour:"100",backupManifests:manifests};
  const reader={capital:async()=>({makerBacking:1_000n,requiredFloor:600n}),balance:async(address:string)=>address.endsWith("2")?5_000n:4_000n,close:()=>{}};
  try{const snapshot=await collectOperationalSnapshot(config,"secret",{fetchImpl,reader});assert.deepEqual(snapshot.api,{ok:true,unresolvedSender:1,approvalP95Ms:700});assert.deepEqual(snapshot.approvers,{healthy:2,disagreements:2});assert.equal(snapshot.oracle.maxAgeMs,1500);assert.deepEqual(snapshot.hedger,{ok:true,maxGapUsdc:50,bandUsdc:100});assert.equal(snapshot.sponsors.minimumGasRunwayHours,40);assert.equal(snapshot.backup.lastSuccessfulAtMs,10_000);assert.equal(JSON.stringify(snapshot).includes("secret"),false);}finally{rmSync(directory,{recursive:true,force:true});}
});
