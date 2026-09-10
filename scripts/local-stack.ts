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
const state = resolve(".local-state", deployment.deploymentId??"legacy-runtime");
mkdirSync(state, { recursive:true });
const chainId=BigInt(deployment.chainId);
const verifyingContract=deployment.clearingAddress;
const approverConfigs = [];const approverProcesses:ChildProcess[]=[];
const servers: Array<{close():Promise<void>}> = [];
// This token is limited to loopback development. Deployed environments must
// supply a random secret and place the operations UI behind private access.
const hedgeHealthToken="local-development-hedge-token";
const indexer=buildIndexer({rpcUrl:deployment.rpcUrl,clearingAddress:deployment.clearingAddress,databasePath:resolve(state,"indexer.sqlite"),startBlock:deployment.deploymentBlock??0,confirmations:2});
await indexer.listen({host:"127.0.0.1",port:4300});servers.push(indexer);
const hedger=buildHedger({indexerUrl:"http://127.0.0.1:4300",databasePath:resolve(state,"hedger.sqlite"),healthToken:hedgeHealthToken});
await hedger.listen({host:"127.0.0.1",port:4400});servers.push(hedger);
const hedgeRiskUrl="http://127.0.0.1:4400/internal/risk",hedgeRiskSource=new HttpHedgeRiskSource(hedgeRiskUrl,hedgeHealthToken);
const waitForHealth=async(url:string,child:ChildProcess)=>{for(let attempt=0;attempt<50;attempt++){if(child.exitCode!==null)throw new Error(`approver exited with ${child.exitCode}`);try{if((await fetch(`${url}/health`,{signal:AbortSignal.timeout(200)})).ok)return;}catch{}await new Promise(resolve=>setTimeout(resolve,100));}throw new Error(`approver did not become ready at ${url}`);};
for (let index=0; index<3; index++) {
  const token=`local-transport-${index}-${crypto.randomUUID()}`,port=4201+index,url=`http://127.0.0.1:${port}`;
  const child=spawn(process.execPath,["--import","tsx",resolve("scripts/approver-process.ts")],{stdio:["ignore","inherit","inherit"],env:{...process.env,RFQ_APPROVER_KEY:deployment.approvers[index].privateKey,RFQ_APPROVER_TOKEN:token,RFQ_APPROVER_DB:resolve(state,`approver-${index}.sqlite`),RFQ_CHAIN_ID:chainId.toString(),RFQ_CLEARING_ADDRESS:verifyingContract,RFQ_RPC_URL:deployment.rpcUrl,RFQ_SECONDARY_RPC_URL:deployment.rpcUrl,RFQ_APPROVER_PORT:String(port),RFQ_MAX_FUTURE_SECONDS:"30",RFQ_HEDGE_RISK_URL:hedgeRiskUrl,RFQ_HEDGE_RISK_TOKEN:hedgeHealthToken}});
  await waitForHealth(url,child);writeFileSync(resolve(state,`approver-${index}.pid`),String(child.pid));approverProcesses.push(child);approverConfigs.push({url,token});
}
const oracleSource=new CoinbaseMarketDataSource();
const api = buildApi({approvers:approverConfigs,chainId,verifyingContract,journalPath:resolve(state,"api.sqlite"),oracleSource,hedgeRiskSource,operationsToken:hedgeHealthToken,publicRpcUrl:deployment.rpcUrl,chain:{rpcUrl:deployment.rpcUrl,sponsorPrivateKey:deployment.sponsorPrivateKey,clearingAddress:deployment.clearingAddress,tokenAddress:deployment.tokenAddress,devFund:true,devWallet:deployment.devWallet}});
await api.listen({host:"127.0.0.1",port:4100}); servers.push(api);
const gateway=buildGateway({upstreamUrl:"http://127.0.0.1:4100"});await gateway.listen({host:"127.0.0.1",port:4500});servers.push(gateway);
console.log("Local RFQ services ready: API :4100; private approvers :4201-4203; indexer :4300; hedge worker :4400; stream gateway :4500");
console.log("Run `npm run dev:web` for the trade UI and `npm run dev:admin` for private hedge operations");
const shutdown = async () => {
  const forced=setTimeout(()=>process.exit(1),5_000);forced.unref();
  for(const child of approverProcesses)child.kill("SIGTERM");
  await Promise.allSettled(servers.map(server=>server.close()));clearTimeout(forced);process.exit(0);
};
process.on("SIGINT", shutdown); process.on("SIGTERM", shutdown);
