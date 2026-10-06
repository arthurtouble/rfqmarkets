import {childEnvironment} from "../packages/shared/src/process-environment.js";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { getAddress, parseUnits } from "ethers";
import { buildApi } from "../services/api/src/server.js";
import { PythHermesSource } from "../services/api/src/oracle.js";
import { buildIndexer } from "../services/indexer/src/server.js";
import { buildHedger } from "../services/hedger/src/server.js";
import { HttpHedgeRiskSource } from "../services/api/src/hedge-risk.js";
import { buildGateway } from "../services/gateway/src/server.js";

// All RFQ services for the Base mainnet dev deployment in one process tree (Cloudflare dev container).
// Inputs: RFQ_DEV_DEPLOYMENT_JSON (the dev deployment record) and RFQ_DEV_RUNTIME_SECRETS_JSON
// ({rpcUrl, secondaryRpcUrl, pythApiKey, sponsorKey, approverKeys[3]}). Hedging uses the local simulator.
// Approvers and the hedger stay on loopback; RFQ_BIND_HOST exposes only the API, indexer and gateway.
type Record={chainId:string;launchProfile:string;contracts:{clearingProxy:string;usdc:string};feedIds:[string,string];deploymentBlock?:number};
type Secrets={rpcUrl:string;secondaryRpcUrl:string;pythApiKey:string;sponsorKey:string;approverKeys:[string,string,string]};
const json=<T>(name:string):T=>{const value=process.env[name];if(!value)throw new Error(`missing ${name}`);return JSON.parse(value) as T;};
const record=json<Record>("RFQ_DEV_DEPLOYMENT_JSON"),secrets=json<Secrets>("RFQ_DEV_RUNTIME_SECRETS_JSON");
if(record.chainId!=="8453"||record.launchProfile!=="dev")throw new Error("dev runtime only serves the Base mainnet dev profile");
if(typeof record.deploymentBlock!=="number")throw new Error("deployment record has no deploymentBlock");
for(const url of [secrets.rpcUrl,secrets.secondaryRpcUrl])if(!url.startsWith("https://"))throw new Error("RPC URLs must use HTTPS");
const clearing=getAddress(record.contracts.clearingProxy),chainId=8453n,state=resolve(process.env.RFQ_DEV_RUNTIME_DIR??".local-state/base-mainnet-dev-runtime");mkdirSync(state,{recursive:true});
const bindHost=process.env.RFQ_BIND_HOST??"127.0.0.1",hedgeToken=`dev-hedge-${crypto.randomUUID()}`,hedgeRiskMaxAgeMs=10_000,servers:Array<{close():Promise<void>}>=[],children:ChildProcess[]=[],approvers:Array<{url:string;token:string}>=[];

const indexer=buildIndexer({rpcUrl:secrets.rpcUrl,clearingAddress:clearing,databasePath:resolve(state,"indexer.sqlite"),startBlock:record.deploymentBlock,confirmations:2});await indexer.listen({host:bindHost,port:4300});servers.push(indexer);
const hedger=buildHedger({indexerUrl:"http://127.0.0.1:4300",databasePath:resolve(state,"hedger.sqlite"),healthToken:hedgeToken,bandUsdc:parseUnits("25000",6),maxOrderUsdc:parseUnits("25000",6),minOrderUsdc:0n,riskStaleMs:hedgeRiskMaxAgeMs});await hedger.listen({host:"127.0.0.1",port:4400});servers.push(hedger);
const hedgeRiskUrl="http://127.0.0.1:4400/internal/risk";
const waitForHealth=async(url:string,child:ChildProcess)=>{for(let attempt=0;attempt<100;attempt++){if(child.exitCode!==null)throw new Error(`approver exited with ${child.exitCode}`);try{if((await fetch(`${url}/health`,{signal:AbortSignal.timeout(250)})).ok)return;}catch{}await new Promise(done=>setTimeout(done,100));}throw new Error(`approver did not become ready at ${url}`);};
for(let index=0;index<3;index++){
  const token=`dev-transport-${index}-${crypto.randomUUID()}`,port=4201+index,url=`http://127.0.0.1:${port}`;
  const child=spawn(process.execPath,["--import","tsx",resolve("scripts/approver-process.ts")],{stdio:["ignore","inherit","inherit"],env:childEnvironment({RFQ_APPROVER_KEY:secrets.approverKeys[index],RFQ_APPROVER_TOKEN:token,RFQ_APPROVER_DB:resolve(state,`approver-${index}.sqlite`),RFQ_CHAIN_ID:"8453",RFQ_CLEARING_ADDRESS:clearing,RFQ_RPC_URL:secrets.rpcUrl,RFQ_SECONDARY_RPC_URL:secrets.secondaryRpcUrl,RFQ_RPC_BATCH_MAX_COUNT:"1",RFQ_APPROVER_PORT:String(port),RFQ_MAX_FUTURE_SECONDS:"5",RFQ_ORACLE_MODE:"pyth",RFQ_HEDGE_RISK_URL:hedgeRiskUrl,RFQ_HEDGE_RISK_TOKEN:hedgeToken,RFQ_HEDGE_RISK_MAX_AGE_MS:String(hedgeRiskMaxAgeMs)})});
  children.push(child);await waitForHealth(url,child);approvers.push({url,token});
}
const api=buildApi({approvers,approverTimeoutMs:5_000,hedgeRiskMaxAgeMs,chainId,verifyingContract:clearing,journalPath:resolve(state,"api.sqlite"),oracleSource:new PythHermesSource({apiKey:secrets.pythApiKey,feedIds:{BTC:record.feedIds[0],ETH:record.feedIds[1]}}),hedgeRiskSource:new HttpHedgeRiskSource(hedgeRiskUrl,hedgeToken),operationsToken:hedgeToken,publicRpcUrl:"https://mainnet.base.org",chain:{rpcUrl:secrets.rpcUrl,sponsorPrivateKey:secrets.sponsorKey,clearingAddress:clearing,tokenAddress:record.contracts.usdc}});
await api.listen({host:bindHost,port:4100});servers.push(api);
const gateway=buildGateway({upstreamUrl:"http://127.0.0.1:4100"});await gateway.listen({host:bindHost,port:4500});servers.push(gateway);
console.log(`Base mainnet dev services ready for ${clearing} from block ${record.deploymentBlock}`);
for(const child of children)child.once("exit",code=>{console.error(`approver exited with ${code}; stopping`);process.exit(1);});
const shutdown=async()=>{const forced=setTimeout(()=>process.exit(1),5_000);forced.unref();for(const child of children){child.removeAllListeners("exit");child.kill("SIGTERM");}await Promise.allSettled(servers.map(server=>server.close()));clearTimeout(forced);process.exit(0);};
process.on("SIGINT",shutdown);process.on("SIGTERM",shutdown);
