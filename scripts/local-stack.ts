import { mkdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { buildApprover } from "../services/approver/src/server.js";
import { buildApi } from "../services/api/src/server.js";
import { buildIndexer } from "../services/indexer/src/server.js";
import { buildHedger } from "../services/hedger/src/server.js";

const state = resolve(".local-state", "runtime");
mkdirSync(state, { recursive:true });
const deployment=JSON.parse(readFileSync(resolve(".local-state","deployment.json"),"utf8")) as {rpcUrl:string;chainId:string;clearingAddress:string;tokenAddress:string;sponsorPrivateKey:string;deploymentBlock?:number;approvers:Array<{address:string;privateKey:string}>};
const chainId=BigInt(deployment.chainId);
const verifyingContract=deployment.clearingAddress;
const approverConfigs = [];
const servers: Array<{close():Promise<void>}> = [];
for (let index=0; index<3; index++) {
  const token = `local-transport-${index}-${crypto.randomUUID()}`;
  const app = buildApprover({ privateKey:deployment.approvers[index].privateKey, transportToken:token, databasePath:resolve(state,`approver-${index}.sqlite`),expectedChainId:chainId,expectedVerifyingContract:verifyingContract,rpcUrl:deployment.rpcUrl });
  const url = await app.listen({host:"127.0.0.1",port:4201+index});
  approverConfigs.push({url,token}); servers.push(app);
}
const api = buildApi({approvers:approverConfigs,chainId,verifyingContract,journalPath:resolve(state,"api.sqlite"),chain:{rpcUrl:deployment.rpcUrl,sponsorPrivateKey:deployment.sponsorPrivateKey,clearingAddress:deployment.clearingAddress,tokenAddress:deployment.tokenAddress,devFund:true}});
await api.listen({host:"127.0.0.1",port:4100}); servers.push(api);
const indexer=buildIndexer({rpcUrl:deployment.rpcUrl,clearingAddress:deployment.clearingAddress,databasePath:resolve(state,"indexer.sqlite"),startBlock:deployment.deploymentBlock??0,confirmations:2});
await indexer.listen({host:"127.0.0.1",port:4300});servers.push(indexer);
const hedger=buildHedger({indexerUrl:"http://127.0.0.1:4300",databasePath:resolve(state,"hedger.sqlite")});
await hedger.listen({host:"127.0.0.1",port:4400});servers.push(hedger);
console.log("Local RFQ services ready: API :4100; private approvers :4201-4203; indexer :4300; hedge worker :4400");
console.log("Run `npm run dev:web` for the trade UI and `npm run dev:admin` for private hedge operations");
const shutdown = async () => { await Promise.all(servers.map(server=>server.close())); process.exit(0); };
process.on("SIGINT", shutdown); process.on("SIGTERM", shutdown);
