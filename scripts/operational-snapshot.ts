import {readFileSync} from "node:fs";
import {resolve} from "node:path";
import {Contract,JsonRpcProvider} from "ethers";
import {z} from "zod";
import {makerStress} from "../packages/shared/src/exposure-admission.js";
import {clearingStateAbi} from "../packages/shared/src/abi.js";
import {requiredEnv} from "./lib/env.js";
import {validateBackupSet} from "./backup-set.js";

const url=z.string().url().refine(value=>value.startsWith("https://")||value.startsWith("http://127.0.0.1:"),"service URL must use HTTPS or loopback HTTP");
export const operationalSnapshotConfigSchema=z.object({
  version:z.literal(1),apiUrl:url,indexerUrl:url,keeperUrl:url,hedgerUrl:url,
  approverUrls:z.tuple([url,url,url]),rpcUrl:url,clearingAddress:z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  sponsorAddresses:z.array(z.string().regex(/^0x[0-9a-fA-F]{40}$/)).min(2),sponsorBurnWeiPerHour:z.string().regex(/^[1-9]\d*$/),
  backupManifests:z.array(z.string().min(1)).length(7),
}).strict();
export type OperationalSnapshotConfig=z.infer<typeof operationalSnapshotConfigSchema>;

type Reader={
  capital():Promise<{makerBacking:bigint;requiredFloor:bigint}>;
  balance(address:string):Promise<bigint>;
  close():void;
};

async function request(fetchImpl:typeof fetch,url:string,token?:string){
  const response=await fetchImpl(url,{headers:token?{authorization:`Bearer ${token}`}:{},signal:AbortSignal.timeout(5_000)});
  if(!response.ok)throw new Error(`${new URL(url).pathname} returned ${response.status}`);
  return response.json() as Promise<any>;
}

export async function collectOperationalSnapshot(configInput:unknown,token:string,options:{fetchImpl?:typeof fetch;reader?:Reader}={}){
  const config=operationalSnapshotConfigSchema.parse(configInput),fetchImpl=options.fetchImpl??fetch;
  if(!token)throw new Error("operations token is required");
  let owned:JsonRpcProvider|undefined;
  const reader=options.reader??(()=>{
    owned=new JsonRpcProvider(config.rpcUrl,undefined,{batchMaxCount:1});const clearing=new Contract(config.clearingAddress,clearingStateAbi,owned);
    return {
      async capital(){const [backing,floor,btc,eth]=await Promise.all([clearing.makerBacking(),clearing.baseRiskCapitalTarget(),clearing.markets(0),clearing.markets(1)]),notional=(state:typeof btc)=>BigInt(state.aggregateBase)*(BigInt(state.lastBid)+BigInt(state.lastAsk))/2n/10n**18n,stress=makerStress(notional(btc),notional(eth))*4n;return {makerBacking:BigInt(backing),requiredFloor:stress>BigInt(floor)?stress:BigInt(floor)};},
      balance:(address:string)=>owned!.getBalance(address),close:()=>owned!.destroy(),
    } satisfies Reader;
  })();
  try{
    const [apiHealth,apiMetrics,indexer,keeper,hedger,...approvers]=await Promise.all([
      request(fetchImpl,`${config.apiUrl}/health`),request(fetchImpl,`${config.apiUrl}/internal/metrics`,token),request(fetchImpl,`${config.indexerUrl}/health`),
      request(fetchImpl,`${config.keeperUrl}/internal/metrics`,token),request(fetchImpl,`${config.hedgerUrl}/v1/status`,token),...config.approverUrls.map(value=>request(fetchImpl,`${value}/health`)),
    ]);
    const [capital,...balances]=await Promise.all([reader.capital(),...config.sponsorAddresses.map(address=>reader.balance(address))]);
    const unresolved=new Set(["signed","submitted","ambiguous","reorged"]),senderRows=Array.isArray(apiMetrics.sender)?apiMetrics.sender:[];
    const oracleAges=Object.values(apiHealth.marketData?.agesMs??{}).filter((value):value is number=>Number.isFinite(value));
    const hedgeMarkets=Object.values(hedger.markets??{}) as Array<{gapNotional?:string;bandUsdc?:string}>;
    const burn=BigInt(config.sponsorBurnWeiPerHour),runway=balances.reduce((minimum,balance)=>{const hours=balance/burn;return hours<minimum?hours:minimum;},2n**255n);
    return {
      observedAtMs:Date.now(),
      api:{ok:Boolean(apiHealth.ok),unresolvedSender:senderRows.filter((row:any)=>unresolved.has(String(row.status))).length,approvalP95Ms:Number(apiMetrics.latency?.tradeApproval?.p95Ms??0)},
      approvers:{healthy:approvers.filter(value=>value.ok===true).length,disagreements:Number(apiMetrics.quorum?.invalidResponses??0)},
      oracle:{maxAgeMs:oracleAges.length?Math.max(...oracleAges):Number.MAX_SAFE_INTEGER},
      indexer:{ok:Boolean(indexer.ok),lagBlocks:Number(indexer.lag??Number.MAX_SAFE_INTEGER)},
      keeper:{ok:Boolean(keeper.ok),lastCompletedAtMs:Number(keeper.lastCompletedAt??0)},
      hedger:{ok:Boolean(hedger.healthy),maxGapUsdc:Math.max(0,...hedgeMarkets.map(value=>Number(value.gapNotional??0))),bandUsdc:Math.min(...hedgeMarkets.map(value=>Number(value.bandUsdc??0)))},
      capital:{makerBackingUsdc:capital.makerBacking.toString(),requiredFloorUsdc:capital.requiredFloor.toString()},
      sponsors:{minimumGasRunwayHours:Number(runway>BigInt(Number.MAX_SAFE_INTEGER)?BigInt(Number.MAX_SAFE_INTEGER):runway)},
      backup:{lastSuccessfulAtMs:validateBackupSet(config.backupManifests).oldestAtMs},
    };
  }finally{reader.close();}
}

if(process.argv[1]&&resolve(process.argv[1])===resolve(new URL(import.meta.url).pathname)){
  const configPath=process.argv[2],outputPath=process.argv[3];if(!configPath||!outputPath)throw new Error("Usage: operational-snapshot CONFIG_JSON OUTPUT_JSON");
  const snapshot=await collectOperationalSnapshot(JSON.parse(readFileSync(configPath,"utf8")),requiredEnv("RFQ_OPERATIONS_TOKEN"));
  const {writeFileSync}=await import("node:fs");writeFileSync(outputPath,`${JSON.stringify(snapshot,null,2)}\n`,{mode:0o600,flag:"wx"});
}
