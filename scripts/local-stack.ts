import {childEnvironment} from "../packages/shared/src/process-environment.js";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { buildApi } from "../services/api/src/server.js";
import { buildIndexer } from "../services/indexer/src/server.js";
import { buildHedger } from "../services/hedger/src/server.js";
import { CoinbaseMarketDataSource } from "../services/api/src/oracle.js";
import { HttpHedgeRiskSource } from "../services/api/src/hedge-risk.js";
import { buildGateway } from "../services/gateway/src/server.js";

const deployment=JSON.parse(readFileSync(resolve(".local-state","deployment.json"),"utf8")) as {deploymentId?:string;rpcUrl:string;chainId:string;clearingAddress:string;tokenAddress:string;sponsorPrivateKey:string;devWallet?:{account:string;privateKey:string};deploymentBlock?:number;approvers:Array<{address:string;privateKey:string}>};
const port=(name:string,fallback:number)=>{const value=Number(process.env[name]??fallback);if(!Number.isInteger(value)||value<1||value>65_535)throw new Error(`${name} must be a valid port`);return value;};
const apiPort=port("RFQ_LOCAL_API_PORT",4100),approverBasePort=port("RFQ_LOCAL_APPROVER_BASE_PORT",4201),indexerPort=port("RFQ_LOCAL_INDEXER_PORT",4300),hedgerPort=port("RFQ_LOCAL_HEDGER_PORT",4400),gatewayPort=port("RFQ_LOCAL_GATEWAY_PORT",4500),webOrigin=process.env.RFQ_LOCAL_WEB_ORIGIN??"http://127.0.0.1:4173";
const state = resolve(".local-state", deployment.deploymentId??"legacy-runtime");
mkdirSync(state, { recursive:true });
const chainId=BigInt(deployment.chainId);
const verifyingContract=deployment.clearingAddress;
const approverConfigs = [];const approverProcesses:ChildProcess[]=[];
const servers: Array<{close():Promise<void>}> = [];
// This token is limited to loopback development. Deployed environments must
// supply a random secret and place the operations UI behind private access.
const hedgeHealthToken="local-development-hedge-token";
const indexer=buildIndexer({rpcUrl:deployment.rpcUrl,clearingAddress:deployment.clearingAddress,databasePath:resolve(state,"indexer.sqlite"),startBlock:deployment.deploymentBlock??0,confirmations:2,corsOrigin:webOrigin});
await indexer.listen({host:"127.0.0.1",port:indexerPort});servers.push(indexer);
const hedger=buildHedger({indexerUrl:`http://127.0.0.1:${indexerPort}`,databasePath:resolve(state,"hedger.sqlite"),healthToken:hedgeHealthToken});
await hedger.listen({host:"127.0.0.1",port:hedgerPort});servers.push(hedger);
const hedgeRiskUrl=`http://127.0.0.1:${hedgerPort}/internal/risk`,hedgeRiskSource=new HttpHedgeRiskSource(hedgeRiskUrl,hedgeHealthToken);
const waitForHealth=async(url:string,child:ChildProcess)=>{for(let attempt=0;attempt<50;attempt++){if(child.exitCode!==null)throw new Error(`approver exited with ${child.exitCode}`);try{if((await fetch(`${url}/health`,{signal:AbortSignal.timeout(200)})).ok)return;}catch{}await new Promise(resolve=>setTimeout(resolve,100));}throw new Error(`approver did not become ready at ${url}`);};
for (let index=0; index<3; index++) {
  const token=`local-transport-${index}-${crypto.randomUUID()}`,port=approverBasePort+index,url=`http://127.0.0.1:${port}`;
  const child=spawn(process.execPath,["--import","tsx",resolve("scripts/approver-process.ts")],{stdio:["ignore","inherit","inherit"],env:childEnvironment({RFQ_APPROVER_KEY:deployment.approvers[index].privateKey,RFQ_APPROVER_TOKEN:token,RFQ_APPROVER_DB:resolve(state,`approver-${index}.sqlite`),RFQ_CHAIN_ID:chainId.toString(),RFQ_CLEARING_ADDRESS:verifyingContract,RFQ_RPC_URL:deployment.rpcUrl,RFQ_SECONDARY_RPC_URL:deployment.rpcUrl,RFQ_APPROVER_PORT:String(port),RFQ_MAX_FUTURE_SECONDS:"30",RFQ_HEDGE_RISK_URL:hedgeRiskUrl,RFQ_HEDGE_RISK_TOKEN:hedgeHealthToken})});
  await waitForHealth(url,child);writeFileSync(resolve(state,`approver-${index}.pid`),String(child.pid));approverProcesses.push(child);approverConfigs.push({url,token});
}
const oracleSource=new CoinbaseMarketDataSource();
const api = buildApi({approvers:approverConfigs,chainId,verifyingContract,journalPath:resolve(state,"api.sqlite"),oracleSource,hedgeRiskSource,operationsToken:hedgeHealthToken,publicRpcUrl:deployment.rpcUrl,corsOrigin:webOrigin,chain:{rpcUrl:deployment.rpcUrl,sponsorPrivateKey:deployment.sponsorPrivateKey,clearingAddress:deployment.clearingAddress,tokenAddress:deployment.tokenAddress,devFund:true,devWallet:deployment.devWallet}});
await api.listen({host:"127.0.0.1",port:apiPort}); servers.push(api);
const gateway=buildGateway({upstreamUrl:`http://127.0.0.1:${apiPort}`,corsOrigin:webOrigin});await gateway.listen({host:"127.0.0.1",port:gatewayPort});servers.push(gateway);
console.log(`Local RFQ services ready: API :${apiPort}; private approvers :${approverBasePort}-${approverBasePort+2}; indexer :${indexerPort}; hedge worker :${hedgerPort}; stream gateway :${gatewayPort}`);
console.log("Run `npm run dev:web` for the trade UI and `npm run dev:admin` for private hedge operations");
const shutdown = async () => {
  const forced=setTimeout(()=>process.exit(1),5_000);forced.unref();
  for(const child of approverProcesses)child.kill("SIGTERM");
  await Promise.allSettled(servers.map(server=>server.close()));clearTimeout(forced);process.exit(0);
};
process.on("SIGINT", shutdown); process.on("SIGTERM", shutdown);
