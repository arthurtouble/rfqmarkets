import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { JsonRpcProvider } from "ethers";
import { buildApi } from "../services/api/src/server.js";
import { PythHermesSource } from "../services/api/src/oracle.js";
import { buildIndexer } from "../services/indexer/src/server.js";
import { buildHedger } from "../services/hedger/src/server.js";
import { HttpHedgeRiskSource } from "../services/api/src/hedge-risk.js";
import { buildGateway } from "../services/gateway/src/server.js";
import { loadDeploymentConfig } from "./deployment-config.js";

type Identity={address:string;privateKey:string};
type Manifest={chainId:string;contracts:{clearingProxy:string;usdc:string};feedIds:[string,string];deploymentBlock?:number};
const required=(name:string)=>{const value=process.env[name];if(!value||value.startsWith("replace_"))throw new Error(`missing ${name}`);return value;};
const config=loadDeploymentConfig(process.env),manifest=JSON.parse(readFileSync(resolve(".local-state/base-sepolia-deployment.json"),"utf8")) as Manifest,identities=JSON.parse(readFileSync(resolve(".local-state/testnet-identities.json"),"utf8")) as {sponsor:Identity;approvers:Identity[]};
if(config.oracleMode!=="pyth")throw new Error("Base Sepolia runtime requires RFQ_ORACLE_MODE=pyth");
const state=resolve(".local-state/base-sepolia-runtime");mkdirSync(state,{recursive:true});const provider=new JsonRpcProvider(config.rpcUrl);
async function deploymentBlock(){if(manifest.deploymentBlock!==undefined)return manifest.deploymentBlock;let low=0,high=await provider.getBlockNumber();while(low<high){const middle=Math.floor((low+high)/2);if(await provider.getCode(manifest.contracts.clearingProxy,middle)==="0x")low=middle+1;else high=middle;}return low;}
const startBlock=await deploymentBlock(),chainId=BigInt(manifest.chainId),servers:Array<{close():Promise<void>}>=[],children:ChildProcess[]=[],approvers:Array<{url:string;token:string}>=[],hedgeToken=`testnet-hedge-${crypto.randomUUID()}`,primaryRpcs=process.env.RFQ_APPROVER_RPC_URLS?.split(","),secondaryRpcs=process.env.RFQ_APPROVER_SECONDARY_RPC_URLS?.split(","),apiPort=Number(process.env.RFQ_API_PORT??4100),approverBasePort=Number(process.env.RFQ_APPROVER_BASE_PORT??4201),indexerPort=Number(process.env.RFQ_INDEXER_PORT??4300),hedgerPort=Number(process.env.RFQ_HEDGER_PORT??4400),gatewayPort=Number(process.env.RFQ_GATEWAY_PORT??4500);
const indexer=buildIndexer({rpcUrl:config.rpcUrl,clearingAddress:manifest.contracts.clearingProxy,databasePath:resolve(state,"indexer.sqlite"),startBlock,confirmations:2});await indexer.listen({host:"127.0.0.1",port:indexerPort});servers.push(indexer);
const hedger=buildHedger({indexerUrl:`http://127.0.0.1:${indexerPort}`,databasePath:resolve(state,"hedger.sqlite"),healthToken:hedgeToken});await hedger.listen({host:"127.0.0.1",port:hedgerPort});servers.push(hedger);
const hedgeRiskUrl=`http://127.0.0.1:${hedgerPort}/internal/risk`,waitForHealth=async(url:string,child:ChildProcess)=>{for(let attempt=0;attempt<100;attempt++){if(child.exitCode!==null)throw new Error(`approver exited with ${child.exitCode}`);try{if((await fetch(`${url}/health`,{signal:AbortSignal.timeout(250)})).ok)return;}catch{}await new Promise(resolve=>setTimeout(resolve,100));}throw new Error(`approver did not become ready at ${url}`);};
for(let index=0;index<3;index++){
  const token=`testnet-transport-${index}-${crypto.randomUUID()}`,port=approverBasePort+index,url=`http://127.0.0.1:${port}`,child=spawn(process.execPath,["--import","tsx",resolve("scripts/approver-process.ts")],{stdio:["ignore","inherit","inherit"],env:{...process.env,RFQ_APPROVER_KEY:identities.approvers[index].privateKey,RFQ_APPROVER_TOKEN:token,RFQ_APPROVER_DB:resolve(state,`approver-${index}.sqlite`),RFQ_CHAIN_ID:chainId.toString(),RFQ_CLEARING_ADDRESS:manifest.contracts.clearingProxy,RFQ_RPC_URL:primaryRpcs?.[index]??"https://base-sepolia-rpc.publicnode.com",RFQ_SECONDARY_RPC_URL:secondaryRpcs?.[index]??config.rpcUrl,RFQ_APPROVER_PORT:String(port),RFQ_MAX_FUTURE_SECONDS:"5",RFQ_ORACLE_MODE:"pyth",RFQ_HEDGE_RISK_URL:hedgeRiskUrl,RFQ_HEDGE_RISK_TOKEN:hedgeToken}});await waitForHealth(url,child);writeFileSync(resolve(state,`approver-${index}.pid`),String(child.pid));children.push(child);approvers.push({url,token});
}
const oracleSource=new PythHermesSource({apiKey:required("PYTH_API_KEY"),feedIds:{BTC:manifest.feedIds[0],ETH:manifest.feedIds[1]}}),api=buildApi({approvers,chainId,verifyingContract:manifest.contracts.clearingProxy,journalPath:resolve(state,"api.sqlite"),oracleSource,hedgeRiskSource:new HttpHedgeRiskSource(hedgeRiskUrl,hedgeToken),chain:{rpcUrl:config.rpcUrl,sponsorPrivateKey:identities.sponsor.privateKey,clearingAddress:manifest.contracts.clearingProxy,tokenAddress:manifest.contracts.usdc}});await api.listen({host:"127.0.0.1",port:apiPort});servers.push(api);
const gateway=buildGateway({upstreamUrl:`http://127.0.0.1:${apiPort}`});await gateway.listen({host:"127.0.0.1",port:gatewayPort});servers.push(gateway);
console.log(`Base Sepolia RFQ services ready from block ${startBlock}: API :${apiPort}; Pyth SSE; approvers :${approverBasePort}-${approverBasePort+2}; indexer :${indexerPort}; simulated hedge :${hedgerPort}; gateway :${gatewayPort}`);
const shutdown=async()=>{const forced=setTimeout(()=>process.exit(1),5_000);forced.unref();for(const child of children)child.kill("SIGTERM");await Promise.allSettled(servers.map(server=>server.close()));clearTimeout(forced);process.exit(0);};process.on("SIGINT",shutdown);process.on("SIGTERM",shutdown);
