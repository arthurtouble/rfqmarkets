import {ConnectionBudget} from "../../../packages/shared/src/connection-budget.js";
import {positionPnl,openingPnl} from "../../../packages/shared/src/account-risk.js";
import type {ExposureBook,ExposureMarket} from "../../../packages/shared/src/exposure-admission.js";
import {GrossReservationBook,type GrossReservation} from "../../../packages/shared/src/gross-reservations.js";
import {finalizedClock} from "../../../packages/shared/src/finalized-clock.js";
import {initializeGrossJournal,persistGross,persistLegacyGross,restoreGross,migrateGross,finalizeGross,bindGrossContext} from "../../../packages/shared/src/gross-reservation-journal.js";
import {isPositionReduction,pendingMakerDebit} from "../../../packages/shared/src/exposure-admission.js";
import {publicError} from "./public-error.js";
import {settlementEvent} from "./settlement-event.js";
import {firstQuorum} from "./quorum.js";
import Fastify from "fastify";
import type { ServerResponse } from "node:http";
import cors from "@fastify/cors";
import { DatabaseSync } from "node:sqlite";
import { AbiCoder, Contract, JsonRpcProvider, Wallet, getAddress, keccak256, parseUnits, recoverAddress, TypedDataEncoder, toUtf8Bytes } from "ethers";
import { z } from "zod";
import { clearingApiAbi } from "../../../packages/shared/src/abi.js";
import { approvalToWire, cancelToWire, cancelTypes, closeToWire, closeTypes, depositToWire, depositTypes, DOMAIN_NAME, DOMAIN_VERSION, hashApproval, hashIntent, intentToWire, intentTypes, recoverCancelSigner, recoverCloseSigner, recoverDepositSigner, recoverIntentSigner, recoverSessionGrantSigner, recoverWithdrawalSigner, sessionGrantToWire, sessionGrantTypes, withdrawalToWire, withdrawalTypes, type CancelIntent, type CloseIntent, type DepositIntent, type MakerApproval, type SessionGrant, type SigningDomain, type TradeIntent, type WithdrawalIntent } from "../../../packages/shared/src/eip712.js";
import { adaptiveSpread, BASE, constructQuote, formatUsdc, marginRate, parseUsdc, quoteRequestSchema, type Exposure, type PriceSnapshot, type PricingParameters, type Quote } from "../../../packages/shared/src/policy.js";
import { quoteToWire } from "../../../packages/shared/src/wire.js";
import { DurableSender } from "./sender.js";
import type { OracleSource } from "./oracle.js";
import { hedgeAdmission, type HedgeRiskSnapshot, type HedgeRiskSource } from "../../../packages/shared/src/hedge-risk.js";
import { LimitTriggerBook } from "./limit-book.js";
import { ExpiryIndex, PendingExposureBook } from "./bounded-state.js";
import { RuntimeMetrics } from "./metrics.js";
import { FlowRiskTracker, type FlowFill } from "./flow-risk.js";
import { ShadowModelTelemetry } from "./shadow-model.js";
import { QuoteAdmission } from "./admission.js";

import {validOwnerSignature} from "./owner-signature.js";
import {archiveApiCommitments,initializeApiRecoveryJournal,restoreApiCommitments,type RecoveredCommitment} from "./recovery.js";

export interface ApiOptions {
  senderBudget?:Pick<import("./sender.js").SenderOptions,"maxFeePerGas"|"maxGasLimit"|"maxValue"|"dailyBudgetWei">;
  provider?:JsonRpcProvider;
  sender?:Pick<DurableSender,"submit"|"reconcile"|"status">;
  prices?: Record<"BTC" | "ETH", PriceSnapshot>;
  approvers?: Array<{ url: string; token: string }>;
  fetchImpl?: typeof fetch;
  corsOrigin?: string;
  chainId?: bigint;
  verifyingContract?: string;
  chain?: { rpcUrl:string; sponsorPrivateKey:string; clearingAddress:string; tokenAddress:string; devFund?:boolean; devWallet?:{account:string;privateKey:string} };
  journalPath?:string;
  oracleSource?:OracleSource;
  maxActiveQuotes?:number;
  maxStreamConnections?:number;
  maxStreamConnectionsPerClient?:number;
  publicReadBurst?:number;
  publicWriteBurst?:number;
  maxRestingOrders?:number;
  hedgeRiskSource?:HedgeRiskSource;
  hedgeRiskMaxAgeMs?:number;
  approverTimeoutMs?:number;
  minSettlementInclusionSeconds?:number;
  publicRpcUrl?:string;
  firmQuoteRatePerSecond?:number;
  firmQuoteBurst?:number;
  maxQuoteAdmissionClients?:number;
  globalFirmQuoteRatePerSecond?:number;
  globalFirmQuoteBurst?:number;
  operationsToken?:string;
  trustedProxy?:string|string[];
}

const intentRequestSchema = z.object({ quoteId:z.string().uuid(), account:z.string(), nonce:z.string().regex(/^\d+$/), reduceOnly:z.boolean().default(false) });
const approvalRequestSchema = intentRequestSchema.extend({ userSignature:z.string().regex(/^0x[0-9a-fA-F]+$/) });
const depositQuoteSchema=z.object({account:z.string(),fromChainId:z.number().int().positive(),fromToken:z.enum(["USDC","USDT","ETH"]),amount:z.string().regex(/^\d+(\.\d{1,18})?$/)});
const depositExecuteSchema=z.object({routeId:z.string().regex(/^0x[0-9a-fA-F]{64}$/),userSignature:z.string().regex(/^0x[0-9a-fA-F]+$/)});
const actionBaseSchema=z.object({account:z.string(),nonce:z.string().regex(/^\d+$/)});
const signedActionSchema=z.object({userSignature:z.string().regex(/^0x[0-9a-fA-F]+$/)});
const withdrawalPrepareSchema=actionBaseSchema.extend({recipient:z.string().optional(),amount:z.string().regex(/^\d+(\.\d{1,6})?$/)});
const withdrawalExecuteSchema=signedActionSchema.extend({intent:z.object({account:z.string(),recipient:z.string(),amount:z.string().regex(/^\d+$/),nonce:z.string().regex(/^\d+$/),deadline:z.string().regex(/^\d+$/)})});
const cancelExecuteSchema=signedActionSchema.extend({intent:z.object({account:z.string(),nonce:z.string().regex(/^\d+$/),deadline:z.string().regex(/^\d+$/)})});
const closePrepareSchema=actionBaseSchema.extend({market:z.enum(["BTC","ETH"])});
const closeExecuteSchema=signedActionSchema.extend({intent:z.object({account:z.string(),market:z.number().int().min(0).max(1),nonce:z.string().regex(/^\d+$/),deadline:z.string().regex(/^\d+$/)})});
const closeQuoteSchema=z.object({account:z.string(),market:z.enum(["BTC","ETH"])});
const sessionPrepareSchema=actionBaseSchema.extend({session:z.string(),marketMask:z.number().int().min(1).max(3),maxTradeAmount:z.string().regex(/^\d+(\.\d{1,6})?$/),maxCumulativeAmount:z.string().regex(/^\d+(\.\d{1,6})?$/),maxFee:z.string().regex(/^\d+(\.\d{1,6})?$/),durationSeconds:z.number().int().min(300).max(2_592_000)});
const sessionExecuteSchema=signedActionSchema.extend({grant:z.object({account:z.string(),session:z.string(),marketMask:z.number().int().min(1).max(3),maxTradeNotional:z.string().regex(/^\d+$/),maxCumulativeNotional:z.string().regex(/^\d+$/),maxFee:z.string().regex(/^\d+$/),validUntil:z.string().regex(/^\d+$/),nonce:z.string().regex(/^\d+$/),deadline:z.string().regex(/^\d+$/)})});
const orderPrepareSchema=z.object({account:z.string(),market:z.enum(["BTC","ETH"]),side:z.enum(["buy","sell"]),amount:z.string().regex(/^\d+(\.\d{1,6})?$/),limitPrice:z.string().regex(/^\d+(\.\d{1,6})?$/),durationSeconds:z.number().int().min(300).max(2_592_000),nonce:z.string().regex(/^\d+$/),reduceOnly:z.boolean().default(false)});
const orderPlaceSchema=z.object({orderId:z.string().uuid(),userSignature:z.string().regex(/^0x[0-9a-fA-F]+$/)});
type DepositRoute={intent:DepositIntent;fromToken:"USDC"|"USDT"|"ETH";amount:string;expectedUsdc:bigint;status:"quoted"|"authorized"|"deposited";destinationTxHash?:string;transaction?:{hash:string;blockNumber:number;collateral:string}};
type ProtocolVersions={leaderEpoch:bigint;signerSetVersion:bigint;policyVersion:bigint;blockNumber:number;blockTimestamp:number};
type RestingOrder={orderId:string;intent:TradeIntent;market:"BTC"|"ETH";side:"buy"|"sell";amount:string;userSignature?:string;status:"prepared"|"open"|"executing"|"filled"|"cancelled"|"expired";createdAtMs:number;updatedAtMs:number;transactionHash?:string;lastError?:string};
const YEAR=365n*24n*60n*60n,RATE=1_000_000_000_000n,DEFAULT_TRADE_LIMIT=1_000_000n*1_000_000n,DEFAULT_MARKET_LIMIT=5_000_000n*1_000_000n;

function abs(value:bigint){return value<0n?-value:value;}
function decodeLimits(word:unknown){const value=BigInt(word as bigint);return {maxTradeNotional:value&((1n<<128n)-1n),maxMarketNotional:value>>128n};}
function quoteSpread(snapshot:PriceSnapshot,riskMode:"normal"|"guarded"|"reduce_only"="normal",toxicityScoreBps=0,execution?:{estimatedCostBps:number;latencyMs:number;basisBps:number}){return adaptiveSpread({volatilityBps:snapshot.volatilityBps,riskMode,toxicityScoreBps,hedgeCostBps:execution?.estimatedCostBps,hedgeLatencyMs:execution?.latencyMs,venueBasisBps:execution?.basisBps});}
function shadowQuoteSpread(snapshot:PriceSnapshot,riskMode:"normal"|"guarded"|"reduce_only",toxicityScoreBps:number,execution?:{estimatedCostBps:number;latencyMs:number;basisBps:number}){return adaptiveSpread({volatilityBps:(snapshot.volatilityBps??0)*1.25,riskMode,toxicityScoreBps,hedgeCostBps:execution?.estimatedCostBps,hedgeLatencyMs:execution?.latencyMs,venueBasisBps:execution?.basisBps});}
function errorText(error:unknown){try{return `${String(error)} ${JSON.stringify(error)}`;}catch{return String(error);}}
function staleOracleFailure(error:unknown){const text=errorText(error).toLowerCase();return text.includes("staleprice")||text.includes("0xd7815800")||text.includes("0x45805f5d");}

export function buildApi(options: ApiOptions = {}) {
  const app = Fastify({ logger:false, bodyLimit:16_384, trustProxy:options.trustedProxy });
  const streamConnections=new ConnectionBudget(options.maxStreamConnections??1000,options.maxStreamConnectionsPerClient??8);
  const runtimeMetrics=new RuntimeMetrics(),requestStarts=new WeakMap<object,number>();
  const quoteAdmission=new QuoteAdmission(options.firmQuoteRatePerSecond,options.firmQuoteBurst,options.maxQuoteAdmissionClients,options.globalFirmQuoteRatePerSecond,options.globalFirmQuoteBurst);
  const publicReads=new QuoteAdmission(100,options.publicReadBurst??200,10_000,2000,4000);
  const publicWrites=new QuoteAdmission(20,options.publicWriteBurst??200,10_000,200,2000);
  const admitQuoteWork=(request:{ip:string},reply:{header(name:string,value:string):unknown;code(status:number):{send(value:unknown):unknown}})=>{if(quoteAdmission.allow(request.ip))return true;reply.header("retry-after","1");reply.code(429).send({error:"quote rate limit exceeded"});return false;};
  const metricLabels:Record<string,string>={"/v1/quote":"firmQuote","/v1/prepare":"intentPrepare","/v1/approve":"tradeApproval","/v1/close/quote":"closeQuote","/v1/account/:address":"accountRead","/v1/markets":"marketRead"};
  app.addHook("onRequest",async(request,reply)=>{requestStarts.set(request,performance.now());if(request.url.split('?',1)[0].startsWith('/v1/')&&request.method!=='OPTIONS'){const admission=request.method==='GET'?publicReads:publicWrites;if(!admission.allow(request.ip))return reply.code(429).header('retry-after','1').send({error:'request rate limit exceeded'});}});
  app.addHook("onResponse",async(request,reply)=>{const route=request.routeOptions.url,label=route?metricLabels[route]:undefined,started=requestStarts.get(request);if(label&&started!==undefined)runtimeMetrics.record(label,performance.now()-started,reply.statusCode);});
  app.register(cors, { origin:options.corsOrigin ?? "http://127.0.0.1:4173" });
  const settled:Exposure = { BTC:0n, ETH:0n };
  const pending=new PendingExposureBook();
  const journal=options.journalPath?new DatabaseSync(options.journalPath):undefined;
  journal?.exec("PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS commitments (quote_id TEXT PRIMARY KEY, market TEXT NOT NULL, delta TEXT NOT NULL, expires_ms INTEGER NOT NULL, status TEXT NOT NULL, intent_json TEXT NOT NULL, user_signature TEXT NOT NULL, approval_json TEXT, tx_hash TEXT, updated_ms INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS deposit_routes (route_id TEXT PRIMARY KEY, account TEXT NOT NULL, from_chain TEXT NOT NULL, from_token TEXT NOT NULL, source_amount TEXT NOT NULL, expected_usdc TEXT NOT NULL, minimum_usdc TEXT NOT NULL, deadline INTEGER NOT NULL, nonce TEXT NOT NULL, status TEXT NOT NULL, destination_tx TEXT, updated_ms INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS resting_orders (order_id TEXT PRIMARY KEY, account TEXT NOT NULL, market TEXT NOT NULL, side TEXT NOT NULL, amount TEXT NOT NULL, intent_json TEXT NOT NULL, user_signature TEXT NOT NULL, status TEXT NOT NULL, created_ms INTEGER NOT NULL, updated_ms INTEGER NOT NULL, tx_hash TEXT, last_error TEXT); CREATE TABLE IF NOT EXISTS flow_fills (fill_id TEXT PRIMARY KEY, market TEXT NOT NULL, side TEXT NOT NULL, price TEXT NOT NULL, notional TEXT NOT NULL, filled_ms INTEGER NOT NULL)");
  if(journal)initializeApiRecoveryJournal(journal);
  const grossReservations=new GrossReservationBook();
  if(journal){initializeGrossJournal(journal);bindGrossContext(journal,"api",`${options.chainId??31337n}:${getAddress(options.verifyingContract??"0x0000000000000000000000000000000000000001").toLowerCase()}`);migrateGross(journal,"api-v1",()=>{for(const row of journal.prepare("SELECT quote_id,intent_json FROM commitments").all()){const item=row as {quote_id:string;intent_json:string},intent=JSON.parse(item.intent_json);persistLegacyGross(journal,item.quote_id,{market:intent.market,baseDelta:BigInt(intent.baseDelta),reduceOnly:intent.reduceOnly,deadline:Number(intent.deadline)});}});restoreGross(journal,grossReservations);}
  const restoredFlow=(journal?.prepare("SELECT market,side,price,notional,filled_ms FROM flow_fills WHERE filled_ms>? ORDER BY filled_ms DESC LIMIT 512").all(Date.now()-240_000)??[]).reverse().map(row=>{const item=row as {market:"BTC"|"ETH";side:"buy"|"sell";price:string;notional:string;filled_ms:number};return{market:item.market,side:item.side,price:BigInt(item.price),notional:BigInt(item.notional),atMs:item.filled_ms} satisfies FlowFill;});
  const flowRisk=new FlowRiskTracker(256,30_000,restoredFlow);
  for(const row of journal?.prepare("SELECT quote_id, market, delta, expires_ms FROM commitments WHERE status IN ('reserved','approved','submitted','ambiguous') AND expires_ms > ?").all(Date.now())??[]){const item=row as {quote_id:string;market:"BTC"|"ETH";delta:string;expires_ms:number};pending.add(item.quote_id,{market:item.market,delta:BigInt(item.delta),expiresAtMs:item.expires_ms});}
  const quotes = new Map<string,Quote>();
  const quoteExpiries=new ExpiryIndex(),preparedOrderExpiries=new ExpiryIndex();
  const quoteReports = new Map<string,{report:string;validUntil:number}>();
  const approvalQuorums=new Map<string,Promise<PromiseSettledResult<{digest:string;signer:string;signature:string}>[]>>();
  const quoteVersions = new Map<string,ProtocolVersions>();
  const quoteBindings = new Map<string,{account:string;nonce:string}>();
  const preparedIntents=new Map<string,TradeIntent>();
  const forcedReduceOnly=new Set<string>();
  const activeSubmissions=new Map<string,Promise<void>>();
  const completedSubmissions=new Map<string,{account:string;nonce:string;userSignature:string;result:unknown;expiresAtMs:number}>();
  const restingOrders=new Map<string,RestingOrder>();
  const limitBook=new LimitTriggerBook();
  const deposits=new Map<string,DepositRoute>();
  for(const row of journal?.prepare("SELECT route_id, account, from_chain, from_token, source_amount, expected_usdc, minimum_usdc, deadline, nonce, status, destination_tx FROM deposit_routes WHERE status = 'deposited' OR (status IN ('quoted','authorized') AND deadline > ?)").all(Math.floor(Date.now()/1_000))??[]){
    const item=row as {route_id:string;account:string;from_chain:string;from_token:"USDC"|"USDT"|"ETH";source_amount:string;expected_usdc:string;minimum_usdc:string;deadline:number;nonce:string;status:"quoted"|"authorized"|"deposited";destination_tx:string|null};
    deposits.set(item.route_id,{intent:{account:item.account,routeId:item.route_id,sourceChainId:BigInt(item.from_chain),sourceTokenHash:keccak256(toUtf8Bytes(item.from_token)),sourceAmount:BigInt(item.source_amount),minimumUsdc:BigInt(item.minimum_usdc),deadline:BigInt(item.deadline),nonce:BigInt(item.nonce)},fromToken:item.from_token,amount:item.source_amount,expectedUsdc:BigInt(item.expected_usdc),status:item.status,destinationTxHash:item.destination_tx??undefined});
  }
  for(const row of journal?.prepare("SELECT * FROM resting_orders WHERE status IN ('open','executing')").all()??[]){const item=row as Record<string,string|number|null>,wire=JSON.parse(String(item.intent_json));const intent:TradeIntent={...wire,account:getAddress(wire.account),baseDelta:BigInt(wire.baseDelta),limitPrice:BigInt(wire.limitPrice),maxFee:BigInt(wire.maxFee),nonce:BigInt(wire.nonce),deadline:BigInt(wire.deadline)},order:RestingOrder={orderId:String(item.order_id),intent,market:item.market as "BTC"|"ETH",side:item.side as "buy"|"sell",amount:String(item.amount),userSignature:String(item.user_signature),status:"open",createdAtMs:Number(item.created_ms),updatedAtMs:Number(item.updated_ms),transactionHash:item.tx_hash?String(item.tx_hash):undefined,lastError:item.last_error?String(item.last_error):undefined};restingOrders.set(order.orderId,order);limitBook.add(order.orderId,order.market,order.side,order.intent.limitPrice,Number(order.intent.deadline)*1_000);}
  const prices = options.prices ?? {
    BTC:{market:"BTC",bid:99_990n*1_000_000n,ask:100_010n*1_000_000n,observedAtMs:Date.now()},
    ETH:{market:"ETH",bid:3_999n*1_000_000n,ask:4_001n*1_000_000n,observedAtMs:Date.now()},
  };
  const fetchImpl = options.fetchImpl ?? fetch;
  const provider=options.provider??(options.chain?new JsonRpcProvider(options.chain.rpcUrl,undefined,{batchMaxCount:1}):undefined);
  if(provider&&options.chain?.devFund)provider.pollingInterval=50;
  const sponsor=provider&&options.chain?new Wallet(options.chain.sponsorPrivateKey,provider):undefined;
  if(journal&&sponsor)bindGrossContext(journal,"api-sponsor",sponsor.address.toLowerCase());
  const sender=options.sender??(provider&&sponsor?new DurableSender(provider,sponsor,journal,{chainId:options.chainId,initialFeeBumpBps:2_500,...options.senderBudget}):undefined);
  const clearing=options.chain&&provider?new Contract(options.chain.clearingAddress,clearingApiAbi,provider):undefined;
  const token=options.chain&&provider?new Contract(options.chain.tokenAddress,["function mint(address,uint256)"],provider):undefined;
  const domain:SigningDomain = {
    name:DOMAIN_NAME, version:DOMAIN_VERSION, chainId:options.chainId ?? 31_337n,
    verifyingContract:getAddress(options.verifyingContract ?? "0x0000000000000000000000000000000000000001"),
  };
  const recoveredCommitments:RecoveredCommitment[]=journal?restoreApiCommitments(journal,domain):[];
  for(const recovered of recoveredCommitments){quotes.set(recovered.quote.quoteId,recovered.quote);preparedIntents.set(recovered.quote.quoteId,recovered.intent);quoteBindings.set(recovered.quote.quoteId,{account:recovered.intent.account,nonce:recovered.intent.nonce.toString()});quoteExpiries.schedule(recovered.quote.quoteId,recovered.quote.expiresAtMs+60_000);}
  const localDevMode=Boolean(options.chain?.devFund&&domain.chainId===31_337n&&options.chain.rpcUrl&&["127.0.0.1","localhost","::1"].includes(new URL(options.chain.rpcUrl).hostname));
  if(options.chain?.devFund&&!localDevMode)throw new Error("development funding requires local chain 31337 on a loopback RPC");
  let localAdvance:Promise<number>|undefined,lastLocalAdvanceAt=0,lastLocalTimestamp=0;
  let reservationTail=Promise.resolve();
  async function acquireReservationLock(){let release!:()=>void;const previous=reservationTail;reservationTail=new Promise<void>(resolve=>{release=resolve;});await previous;return release;}
  const finalizeReservations=(block:number,timestamp:number,hash?:string)=>{const expired=finalizeGross(journal,grossReservations,block,timestamp,hash,ids=>{if(journal)archiveApiCommitments(journal,ids,Date.now(),false);});for(const id of expired)pending.delete(id);if(expired.length)marketReadCache=undefined;return expired;};
  let quoteSnapshotCache:{at:number;blockNumber:number;promise:Promise<{blockNumber:number;values:any[]}>}|undefined;const shadowTelemetry=new ShadowModelTelemetry();
  let marketReadCache:{at:number;promise:Promise<any>}|undefined;
  let senderReconciliation:Promise<void>|undefined;let senderReconcileTimer:ReturnType<typeof setInterval>|undefined;let orderTimer:ReturnType<typeof setTimeout>|undefined,orderReconcileTimer:ReturnType<typeof setInterval>|undefined,checkingOrders=false,orderCheckQueued=false;
  type StreamClient={response:ServerResponse;writable:boolean};
  const marketClients=new Set<StreamClient>();
  let streamTimer:ReturnType<typeof setTimeout>|undefined,heartbeatTimer:ReturnType<typeof setInterval>|undefined,streamSequence=0,streamPublishing=false,streamPublishQueued=false,lastMarketPayload="",unsubscribeOracle:(()=>void)|undefined;

  function writeEvent(client:StreamClient,event:string,payload:unknown){
    if(client.response.destroyed||client.response.writableEnded)return false;
    if(!client.writable){if(client.response.writableLength>262_144)client.response.destroy();return false;}
    const ok=client.response.write(`id: ${++streamSequence}\nevent: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
    if(!ok){client.writable=false;client.response.once("drain",()=>{client.writable=true;});}
    return true;
  }
  function addStreamClient(response:ServerResponse,clients:Set<StreamClient>){const client={response,writable:true};clients.add(client);response.on("close",()=>clients.delete(client));return client;}
  function scheduleStreamPublish(delay=40){if(!marketClients.size)return;if(streamPublishing){streamPublishQueued=true;return;}if(streamTimer)return;streamTimer=setTimeout(()=>{streamTimer=undefined;void publishStreams();},delay);streamTimer.unref();}
  function scheduleOrderCheck(delay=25){if(checkingOrders){orderCheckQueued=true;return;}if(orderTimer)return;orderTimer=setTimeout(()=>{orderTimer=undefined;void checkRestingOrders();},delay);orderTimer.unref();}
  async function hedgeRisk():Promise<HedgeRiskSnapshot|undefined>{if(!options.hedgeRiskSource)return undefined;try{const value=await options.hedgeRiskSource.latest();if(!value.observedAtMs||Date.now()-value.observedAtMs>(options.hedgeRiskMaxAgeMs??3_000))throw new Error("stale hedge health");return value;}catch{return {observedAtMs:0,healthy:false,indexedBlock:-1,markets:{BTC:{mode:"reduce_only",gapNotional:"0",bandUsdc:"0"},ETH:{mode:"reduce_only",gapNotional:"0",bandUsdc:"0"}}};}}
  async function settlementOracle(market:"BTC"|"ETH"){
    if(!options.oracleSource)throw new Error("oracle unavailable");
    return options.oracleSource.settlement?options.oracleSource.settlement(market):options.oracleSource.latest(market);
  }

  function prune(now=Date.now()) {
    pending.prune(now);
    for(const id of quoteExpiries.takeExpired(now)){quotes.delete(id);quoteReports.delete(id);quoteVersions.delete(id);quoteBindings.delete(id);preparedIntents.delete(id);forcedReduceOnly.delete(id);}
    for(const [id,item] of completedSubmissions)if(item.expiresAtMs<=now)completedSubmissions.delete(id);
    for(const id of preparedOrderExpiries.takeExpired(now)){const order=restingOrders.get(id);if(order?.status==="prepared")restingOrders.delete(id);}
  }
  function collectApprovals(digest:string,payload:unknown){
    const existing=approvalQuorums.get(digest);if(existing)return existing;
    const job=firstQuorum((options.approvers??[]).map(async approver=>{
      const response=await fetchImpl(`${approver.url}/approve`,{method:"POST",headers:{"content-type":"application/json",authorization:`Bearer ${approver.token}`},body:JSON.stringify(payload),signal:AbortSignal.timeout(options.approverTimeoutMs??1_000)});
      if(!response.ok)throw new Error(`approver ${response.status}: ${await response.text()}`);
      const result=await response.json() as {digest:string;signer:string;signature:string};
      if(result.digest!==digest||recoverAddress(digest,result.signature).toLowerCase()!==result.signer.toLowerCase())throw new Error("invalid approver response");
      if(clearing&&!await clearing.isApprover(result.signer))throw new Error("signer is not a current approver");
      return result;
    }),result=>result.signer.toLowerCase()).then(results=>{if(new Set(results.flatMap(item=>item.status==="fulfilled"?[item.value.signer.toLowerCase()]:[])).size<2)approvalQuorums.delete(digest);return results;});
    // Successful immutable approvals are safe to reuse for idempotent client
    // retries. Bound the cache independently of active quote capacity.
    if(approvalQuorums.size>=100_000)approvalQuorums.delete(approvalQuorums.keys().next().value!);
    approvalQuorums.set(digest,job);return job;
  }
  const activeOrderCount=()=>{let count=0;for(const order of restingOrders.values())if(order.status==="prepared"||order.status==="open"||order.status==="executing")count++;return count;};
  function makeIntent(quote:Quote,versions:ProtocolVersions,account:string,nonce:string,reduceOnly=false):TradeIntent {
    const prepared=preparedIntents.get(quote.quoteId);if(prepared)return prepared;
    // The user authorizes quantity, price protection, fee and a short execution
    // interval. Oracle proof freshness is independent: a fresh proof is fetched
    // after wallet signing and bound by the approvers immediately before submit.
    const deadline=versions.blockTimestamp+30,protectedNotional=abs(quote.baseDelta)*quote.worstPrice/BASE,feeNotional=protectedNotional>quote.notional?protectedNotional:quote.notional,maxFee=(feeNotional*quote.fee+quote.notional-1n)/quote.notional;
    return { account:getAddress(account),market:quote.market==="BTC"?0:1,baseDelta:quote.baseDelta,limitPrice:quote.worstPrice,maxFee,nonce:BigInt(nonce),deadline:BigInt(deadline),reduceOnly:reduceOnly||forcedReduceOnly.has(quote.quoteId) };
  }
  async function readProtocolVersions():Promise<ProtocolVersions>{
    if(!clearing||!provider)return {leaderEpoch:1n,signerSetVersion:1n,policyVersion:1n,blockNumber:0,blockTimestamp:Math.floor(Date.now()/1_000)};
    const blockNumber=Number(BigInt(await provider.send("eth_blockNumber",[])));
    const [block,leaderEpoch,signerSetVersion,policyVersion,paused,resolutionRequired]=await Promise.all([
      provider.getBlock(blockNumber),
      clearing.leaderEpoch({blockTag:blockNumber}),clearing.signerSetVersion({blockTag:blockNumber}),clearing.policyVersion({blockTag:blockNumber}),
      clearing.paused({blockTag:blockNumber}),clearing.resolutionRequired({blockTag:blockNumber}),
    ]);
    if(!block||paused||resolutionRequired)throw new Error("market is paused");
    return {leaderEpoch:BigInt(leaderEpoch),signerSetVersion:BigInt(signerSetVersion),policyVersion:BigInt(policyVersion),blockNumber,blockTimestamp:block.timestamp};
  }
  async function advanceLocalChainTime(){
    if(!provider)throw new Error("local chain unavailable");
    if(Date.now()-lastLocalAdvanceAt<250&&lastLocalTimestamp)return lastLocalTimestamp;
    if(localAdvance)return localAdvance;
    localAdvance=(async()=>{const latest=await provider.send("eth_getBlockByNumber",["latest",false]) as {timestamp:string};const timestamp=Math.max(Math.floor(Date.now()/1_000),Number(BigInt(latest.timestamp))+1);await provider.send("evm_setNextBlockTimestamp",[timestamp]);await provider.send("evm_mine",[]);lastLocalAdvanceAt=Date.now();lastLocalTimestamp=timestamp;quoteSnapshotCache=undefined;return timestamp;})().finally(()=>{localAdvance=undefined});
    return localAdvance;
  }
  async function chainTimestamp(){if(!provider)return Math.floor(Date.now()/1_000);const block=await provider.getBlock("latest");if(!block)throw new Error("latest block unavailable");return block.timestamp;}
  async function readQuoteSnapshot(){
    if(!clearing||!provider)throw new Error("chain unavailable");const now=Date.now();if(quoteSnapshotCache&&now-quoteSnapshotCache.at<100)return quoteSnapshotCache.promise;const blockNumber=Number(BigInt(await provider.send("eth_blockNumber",[])));if(quoteSnapshotCache&&quoteSnapshotCache.blockNumber===blockNumber&&now-quoteSnapshotCache.at<250)return quoteSnapshotCache.promise;
    const promise=(async()=>{const values=await Promise.all([provider.getBlock(blockNumber),clearing.markets(0,{blockTag:blockNumber}),clearing.markets(1,{blockTag:blockNumber}),clearing.marketLimitWord(0,{blockTag:blockNumber}),clearing.marketLimitWord(1,{blockTag:blockNumber}),clearing.leaderEpoch({blockTag:blockNumber}),clearing.signerSetVersion({blockTag:blockNumber}),clearing.policyVersion({blockTag:blockNumber}),clearing.paused({blockTag:blockNumber}),clearing.resolutionRequired({blockTag:blockNumber})]);return {blockNumber,values};})();quoteSnapshotCache={at:now,blockNumber,promise};try{return await promise;}catch(error){quoteSnapshotCache=undefined;throw error;}
  }

  async function readMarkets(){
    const now=Date.now();if(marketReadCache&&now-marketReadCache.at<500)return marketReadCache.promise;
    const promise=(async()=>{
      if(options.oracleSource){const observations=await Promise.all([options.oracleSource.latest("BTC"),options.oracleSource.latest("ETH")]);for(const observation of observations)prices[observation.snapshot.market]=observation.snapshot;}
      const blockNumber=provider?Number(BigInt(await provider.send("eth_blockNumber",[]))):0;
      const block=provider?await provider.getBlock(blockNumber):null;
      const [chainMarkets,limitWords]=clearing?await Promise.all([Promise.all([clearing.markets(0,{blockTag:blockNumber}),clearing.markets(1,{blockTag:blockNumber})]),Promise.all([clearing.marketLimitWord(0,{blockTag:blockNumber}),clearing.marketLimitWord(1,{blockTag:blockNumber})])]):[[null,null],[null,null]];
      const result:Record<string,unknown>={};
      for(const [index,name] of (["BTC","ETH"] as const).entries()){
        const snapshot=prices[name],chain=chainMarkets[index],limits=limitWords[index]===null?{maxTradeNotional:DEFAULT_TRADE_LIMIT,maxMarketNotional:DEFAULT_MARKET_LIMIT}:decodeLimits(limitWords[index]),mid=(snapshot.bid+snapshot.ask)/2n,aggregateBase=chain?BigInt(chain.aggregateBase):0n;
        const inventoryMark=chain&&BigInt(chain.lastBid)+BigInt(chain.lastAsk)>0n?(BigInt(chain.lastBid)+BigInt(chain.lastAsk))/2n:mid;settled[name]=aggregateBase*inventoryMark/BASE;
        const skewNotional=aggregateBase*mid/BASE;let fundingApr=skewNotional*RATE/limits.maxMarketNotional;if(fundingApr>RATE)fundingApr=RATE;if(fundingApr<-RATE)fundingApr=-RATE;
        const storedIndex=chain?BigInt(chain.fundingIndex):0n,fundingTime=chain?Number(chain.fundingTime):Math.floor(now/1_000),elapsed=BigInt(Math.max(0,(block?.timestamp??Math.floor(now/1_000))-fundingTime));
        const projectedFundingIndex=storedIndex+mid*fundingApr*elapsed/(RATE*YEAR);
        result[name]={market:name,bid:snapshot.bid.toString(),ask:snapshot.ask.toString(),mid:mid.toString(),observedAtMs:snapshot.observedAtMs,source:snapshot.source??"configured",volatilityBps:snapshot.volatilityBps??0,volatility:snapshot.volatility,baseSpreadBps:0,aggregateBase:aggregateBase.toString(),fundingApr:fundingApr.toString(),fundingIndex:storedIndex.toString(),projectedFundingIndex:projectedFundingIndex.toString(),fundingTime,lastPriceTime:chain?Number(chain.lastPriceTime):0,enabled:chain?Boolean(chain.enabled):true,maxTradeNotional:limits.maxTradeNotional.toString(),maxMarketNotional:limits.maxMarketNotional.toString()};
      }
      const operational=await hedgeRisk();for(const name of ["BTC","ETH"] as const){const item=result[name] as Record<string,unknown>,venue=operational?.markets[name],mode=venue?.mode??"normal",admission=hedgeAdmission(mode,settled[name],0n,BigInt(item.maxTradeNotional as string)),spread=quoteSpread(prices[name],mode,flowRisk.score(name,prices[name],now),venue?.execution);item.riskMode=mode;item.baseSpreadBps=Number(spread.totalBps);item.spread=Object.fromEntries(Object.entries(spread).map(([key,value])=>[key,typeof value==="bigint"?value.toString():value]));item.operatingMaxTradeNotional=admission.maxTradeNotional.toString();item.canBuy=admission.canBuy;item.canSell=admission.canSell;}
      prune(now);const pendingEnvelope=pending.envelope();
      return {blockNumber,serverTimeMs:now,markets:result,pricing:{settled:{BTC:settled.BTC.toString(),ETH:settled.ETH.toString()},pending:pendingEnvelope,baseSpreadBps:2,feeBps:2,toleranceBps:8}};
    })();marketReadCache={at:now,promise};try{return await promise;}catch(error){marketReadCache=undefined;throw error;}
  }

  async function createQuote(request:{market:"BTC"|"ETH";side:"buy"|"sell";amount:string},persist=true,exactBaseDelta?:bigint,reductionAccount?:string,excludeReservation?:string){
    prune();const reservationRevision=pending.revision;if(persist&&quotes.size>=(options.maxActiveQuotes??50_000))throw new Error("firm quote capacity reached");let oracleQuote:Awaited<ReturnType<OracleSource["latest"]>>|undefined;
    let versions:ProtocolVersions,maxTradeNotional=DEFAULT_TRADE_LIMIT;
    if(clearing&&provider){
      if(options.chain?.devFund)await advanceLocalChainTime();
      let {blockNumber,values}=await readQuoteSnapshot();let [block,btc,eth,btcLimits,ethLimits,leaderEpoch,signerSetVersion,policyVersion,paused,resolutionRequired]=values;
      if(!block||paused||resolutionRequired)throw new Error("market is paused");
      const otherMarket=request.market==="BTC"?"ETH":"BTC",otherIndex=otherMarket==="BTC"?0:1,otherState=otherIndex===0?btc:eth;
      const otherBook=await clearing.exposureState(otherIndex,{blockTag:blockNumber});if(!otherBook.ready)throw new Error("exposure migration required");
      if(sender&&(BigInt(otherBook.longBase)+BigInt(otherBook.shortBase)+grossReservations.bounds()[otherIndex].longBase+grossReservations.bounds()[otherIndex].shortBase!==0n)&&block.timestamp-Number(otherState.lastPriceTime)>8){let report:string,value=0n;if(options.chain?.devFund){const snapshot=prices[otherMarket];report=AbiCoder.defaultAbiCoder().encode(["tuple(uint8 market,uint256 bid,uint256 ask,uint64 observedAt,uint64 validUntil)"],[[otherIndex,snapshot.bid,snapshot.ask,BigInt(block.timestamp),BigInt(block.timestamp+60)]]);}else{const observation=await settlementOracle(otherMarket);prices[otherMarket]=observation.snapshot;report=observation.report;const oracleAddress=await clearing.oracle({blockTag:blockNumber}),adapter=new Contract(oracleAddress,["function updateFee(bytes) view returns(uint256)"],provider);value=BigInt(await adapter.updateFee(report,{blockTag:blockNumber}));}await sender.submit(`oracle:${otherMarket}:${keccak256(report)}`,{to:domain.verifyingContract,data:clearing.interface.encodeFunctionData("refreshOracle",[report]),value,gasLimit:750_000n});quoteSnapshotCache=undefined;({blockNumber,values}=await readQuoteSnapshot());[block,btc,eth,btcLimits,ethLimits,leaderEpoch,signerSetVersion,policyVersion,paused,resolutionRequired]=values;if(!block||paused||resolutionRequired)throw new Error("market is paused");}
      if(options.oracleSource){oracleQuote=await settlementOracle(request.market);prices[request.market]=oracleQuote.snapshot;}else prices[request.market].observedAtMs=Date.now();
      const marketNotional=(state:any,currentMark?:bigint)=>BigInt(state.aggregateBase)*(currentMark??(BigInt(state.lastBid)+BigInt(state.lastAsk))/2n)/BASE;
      const quoteMid=(prices[request.market].bid+prices[request.market].ask)/2n;
      settled.BTC=marketNotional(btc,request.market==="BTC"?quoteMid:undefined);settled.ETH=marketNotional(eth,request.market==="ETH"?quoteMid:undefined);
      versions={leaderEpoch:BigInt(leaderEpoch),signerSetVersion:BigInt(signerSetVersion),policyVersion:BigInt(policyVersion),blockNumber,blockTimestamp:block.timestamp};
      maxTradeNotional=decodeLimits(request.market==="BTC"?btcLimits:ethLimits).maxTradeNotional;
      if(exactBaseDelta!==undefined&&reductionAccount){const position=await clearing.positionOf(reductionAccount,request.market==="BTC"?0:1,{blockTag:blockNumber});if(isPositionReduction(BigInt(position.size),exactBaseDelta)){const reductionNotional=abs(exactBaseDelta)*quoteMid/BASE;if(reductionNotional>maxTradeNotional)maxTradeNotional=reductionNotional;}}
    }else {versions=await readProtocolVersions();if(options.oracleSource){oracleQuote=await settlementOracle(request.market);prices[request.market]=oracleQuote.snapshot;}else prices[request.market].observedAtMs=Date.now();}
    const operational=await hedgeRisk(),mode=operational?.markets[request.market].mode??"normal",quoteMid=(prices[request.market].bid+prices[request.market].ask)/2n,delta=exactBaseDelta===undefined?(request.side==="buy"?parseUsdc(request.amount):-parseUsdc(request.amount)):exactBaseDelta*quoteMid/BASE,admission=hedgeAdmission(mode,settled[request.market],delta,maxTradeNotional);if(!admission.allowed)throw new Error("hedging unavailable: only exposure-reducing trades are allowed");
    const toxicity=flowRisk.score(request.market,prices[request.market]),execution=operational?.markets[request.market].execution,spread=quoteSpread(prices[request.market],mode,toxicity,execution),shadow=shadowQuoteSpread(prices[request.market],mode,toxicity,execution);shadowTelemetry.observe(Number(spread.totalBps),Number(shadow.totalBps));const pricing:PricingParameters={maxNotional:admission.maxTradeNotional,baseSpreadBps:spread.totalBps,feeBps:2n,toleranceBps:8n,spread};
    const quote=constructQuote(request,{...prices[request.market]},settled,pending.exposure(excludeReservation),Date.now(),crypto.randomUUID(),pricing,exactBaseDelta);
    let oracleReport:{report:string;validUntil:number}|undefined;
    if(oracleQuote){
      const localTimestamp=options.chain?.devFund?versions.blockTimestamp:undefined;
      const validUntil=localTimestamp===undefined?oracleQuote.validUntil:localTimestamp+60;
      const report=localTimestamp===undefined?oracleQuote.report:AbiCoder.defaultAbiCoder().encode(["tuple(uint8 market,uint256 bid,uint256 ask,uint64 observedAt,uint64 validUntil)"],[[request.market==="BTC"?0:1,quote.snapshot.bid,quote.snapshot.ask,localTimestamp,validUntil]]);
      quote.expiresAtMs=Math.min(quote.expiresAtMs,validUntil*1_000-4_000);if(quote.expiresAtMs<=Date.now())throw new Error("oracle report lacks inclusion time");if(persist)quoteReports.set(quote.quoteId,{report,validUntil});
      oracleReport={report,validUntil};
    }
    if(persist){quotes.set(quote.quoteId,quote);quoteVersions.set(quote.quoteId,versions);quoteExpiries.schedule(quote.quoteId,quote.expiresAtMs+60_000);}return {quote,versions,oracleReport,reservationRevision};
  }

  async function publishStreams(){
    if(streamPublishing)return;streamPublishing=true;
    try{
      if(marketClients.size){try{const snapshot=await readMarkets(),payload=JSON.stringify(snapshot);if(payload!==lastMarketPayload){lastMarketPayload=payload;for(const client of marketClients)writeEvent(client,"markets",snapshot);}}catch(error){for(const client of marketClients)writeEvent(client,"stream-error",{error:publicError(error,"market data unavailable")});}}
    }finally{streamPublishing=false;if(streamPublishQueued){streamPublishQueued=false;scheduleStreamPublish();}}
  }

  const operationalSnapshot=()=>({grossReservations:{active:grossReservations.size,capacity:options.maxActiveQuotes??50_000,finalizedBlock:grossReservations.finalizedBlock,finalizedTimestamp:grossReservations.finalizedTimestamp},quoteModel:{version:"adaptive-v1",restoredPaidFills:flowRisk.entries().length,markets:Object.fromEntries((["BTC","ETH"] as const).map(market=>[market,{toxicityScoreBps:flowRisk.score(market,prices[market]),volatility:prices[market].volatility??null}]))},shadowModel:shadowTelemetry.snapshot(),streams:{connections:marketClients.size,eventsSent:streamSequence},firmQuotes:{active:quotes.size,capacity:options.maxActiveQuotes??50_000},orders:{active:activeOrderCount(),indexed:limitBook.size,capacity:options.maxRestingOrders??100_000},sender:sender?.status(),latency:runtimeMetrics.snapshot()});
  app.get("/health",async()=>({ok:!sender?.status().some(row=>["signed","submitted","ambiguous","reorged"].includes(String(row.status))),role:"leader",epoch:(clearing?await clearing.leaderEpoch():1n).toString(),chain:options.chain?{chainId:domain.chainId.toString(),clearingAddress:domain.verifyingContract}:null,marketData:options.oracleSource?.status?.()??{source:"configured"}}));
  app.get("/internal/metrics",async(request,reply)=>{if(!options.operationsToken||request.headers.authorization!==`Bearer ${options.operationsToken}`)return reply.code(401).send({error:"unauthorized"});return operationalSnapshot();});
  app.get("/v1/config",async()=>({chainId:`0x${domain.chainId.toString(16)}`,chainName:options.chain?.devFund?"RFQ Local":domain.chainId===84532n?"Base Sepolia":"Base",rpcUrl:options.publicRpcUrl,clearingAddress:domain.verifyingContract,tokenAddress:options.chain?.tokenAddress}));
  if(localDevMode&&options.chain?.devWallet)app.get("/v1/dev/wallet",async()=>({mode:"local-development",...options.chain!.devWallet}));
  app.get("/v1/markets",async(_request,reply)=>{try{return await readMarkets();}catch(error){return reply.code(503).send({error:publicError(error,"market data unavailable")});}});
  app.get("/v1/markets/stream",async(request,reply)=>{
    const release=streamConnections.acquire(request.ip);if(!release)return reply.code(429).header("retry-after","5").send({error:"stream connection limit reached"});reply.raw.once("close",release);
    reply.hijack();reply.raw.writeHead(200,{"content-type":"text/event-stream","cache-control":"no-cache, no-transform","connection":"keep-alive","access-control-allow-origin":options.corsOrigin??"http://127.0.0.1:4173"});
    const client=addStreamClient(reply.raw,marketClients);void readMarkets().then(snapshot=>writeEvent(client,"markets",snapshot)).catch(error=>writeEvent(client,"stream-error",{error:publicError(error,"market data unavailable")}));
  });
  app.get("/v1/account/:address",async(request,reply)=>{
    if(!clearing)return reply.code(503).send({error:"chain unavailable"});
    try {
      const account=getAddress((request.params as {address:string}).address),marketSnapshot=await readMarkets(),blockNumber=marketSnapshot.blockNumber;
      const [collateralRaw,btc,eth,onchainMaintenanceEquity,onchainOpeningEquity,onchainInitialMargin,onchainMaintenanceMargin]=await Promise.all([clearing.collateralOf(account,{blockTag:blockNumber}),clearing.positionOf(account,0,{blockTag:blockNumber}),clearing.positionOf(account,1,{blockTag:blockNumber}),clearing.maintenanceEquity(account,{blockTag:blockNumber}),clearing.openingEquity(account,{blockTag:blockNumber}),clearing.initialMargin(account,{blockTag:blockNumber}),clearing.maintenanceMargin(account,{blockTag:blockNumber})]);
      const collateral=BigInt(collateralRaw),positionsRaw=[btc,eth],names=["BTC","ETH"] as const;let unrealizedPnl=0n,accruedFunding=0n,grossNotional=0n,initialMargin=0n,maintenanceMargin=0n;
      const positions:Record<string,unknown>={},positionPnls:bigint[]=[];
      for(const [index,name] of names.entries()){
        const position=positionsRaw[index],size=BigInt(position.size),entryPrice=BigInt(position.entryPrice),market=marketSnapshot.markets[name],mark=size>=0n?BigInt(market.bid):BigInt(market.ask),notional=abs(size)*BigInt(market.ask)/BASE;
        const pnl=positionPnl(size,entryPrice,mark);positionPnls.push(pnl);
        const fundingPnl=-size*(BigInt(market.projectedFundingIndex)-BigInt(position.lastFundingIndex))/BASE;
        unrealizedPnl+=pnl;accruedFunding+=fundingPnl;grossNotional+=notional;initialMargin+=notional*marginRate(notional,true)/10_000n;maintenanceMargin+=notional*marginRate(notional,false)/10_000n;
        positions[name]={size:size.toString(),entryPrice:entryPrice.toString(),markPrice:mark.toString(),notional:notional.toString(),unrealizedPnl:pnl.toString(),accruedFunding:fundingPnl.toString(),lastFundingIndex:position.lastFundingIndex.toString()};
      }
      const equity=collateral+unrealizedPnl+accruedFunding,openingEquity=collateral+accruedFunding+openingPnl(positionPnls),availableMargin=openingEquity-initialMargin,maintenanceBuffer=equity-maintenanceMargin;
      const healthAt=(selected:number,candidateMid:bigint)=>{let value=collateral+accruedFunding,required=0n;for(const [index,name] of names.entries()){const position=positionsRaw[index],size=BigInt(position.size);if(size===0n)continue;const current=marketSnapshot.markets[name],currentMid=BigInt(current.mid),bid=index===selected?candidateMid*BigInt(current.bid)/currentMid:BigInt(current.bid),ask=index===selected?candidateMid*BigInt(current.ask)/currentMid:BigInt(current.ask),entry=BigInt(position.entryPrice),quantity=abs(size);value+=positionPnl(size,entry,size>0n?bid:ask);const notional=quantity*ask/BASE;required+=notional*marginRate(notional,false)/10_000n;}return value-required;};
      for(const [index,name] of names.entries()){const size=BigInt(positionsRaw[index].size);if(size===0n)continue;const currentMid=BigInt(marketSnapshot.markets[name].mid);let low=size>0n?1n:currentMid,high=size>0n?currentMid:currentMid*20n,liquidation:bigint|null=null;if(healthAt(index,currentMid)<=0n)liquidation=currentMid;else if(healthAt(index,size>0n?low:high)<=0n){for(let step=0;step<80;step++){const middle=(low+high)/2n;if(size>0n){if(healthAt(index,middle)<=0n)low=middle;else high=middle;}else{if(healthAt(index,middle)>0n)low=middle;else high=middle;}}liquidation=size>0n?high:high;}(positions[name] as Record<string,unknown>).estimatedLiquidationPrice=liquidation?.toString()??null;}
      return {account,blockNumber,collateral:collateral.toString(),equity:equity.toString(),openingEquity:openingEquity.toString(),unrealizedPnl:unrealizedPnl.toString(),accruedFunding:accruedFunding.toString(),grossNotional:grossNotional.toString(),initialMargin:initialMargin.toString(),maintenanceMargin:maintenanceMargin.toString(),availableMargin:availableMargin.toString(),maintenanceBuffer:maintenanceBuffer.toString(),marginRatioBps:equity>0n?(maintenanceMargin*10_000n/equity).toString():null,effectiveLeverageBps:equity>0n?(grossNotional*10_000n/equity).toString():null,liquidatable:equity<maintenanceMargin,positions,onchain:{maintenanceEquity:onchainMaintenanceEquity.toString(),openingEquity:onchainOpeningEquity.toString(),initialMargin:onchainInitialMargin.toString(),maintenanceMargin:onchainMaintenanceMargin.toString()}};
    }
    catch{return reply.code(400).send({error:"invalid account"});}
  });
  app.post("/v1/deposit/quote",async(request,reply)=>{
    const parsed=depositQuoteSchema.safeParse(request.body);if(!parsed.success)return reply.code(400).send({error:"invalid deposit request"});
    try {
      const account=getAddress(parsed.data.account),decimals=parsed.data.fromToken==="ETH"?18:6,sourceAmount=parseUnits(parsed.data.amount,decimals);
      if(sourceAmount<=0n)throw new Error();
      const grossUsdc=parsed.data.fromToken==="ETH"?sourceAmount*2_500n*1_000_000n/10n**18n:sourceAmount;
      const expectedUsdc=grossUsdc*9_970n/10_000n,minimumUsdc=expectedUsdc*9_950n/10_000n;
      if(minimumUsdc<10n*1_000_000n)throw new Error("minimum deposit is 10 USDC");
      const routeId=keccak256(toUtf8Bytes(crypto.randomUUID())),deadline=BigInt(Math.floor(Date.now()/1_000)+120),nonce=BigInt(`0x${crypto.randomUUID().replaceAll("-","")}`);
      const intent:DepositIntent={account,routeId,sourceChainId:BigInt(parsed.data.fromChainId),sourceTokenHash:keccak256(toUtf8Bytes(parsed.data.fromToken)),sourceAmount,minimumUsdc,deadline,nonce};
      const route:DepositRoute={intent,fromToken:parsed.data.fromToken,amount:parsed.data.amount,expectedUsdc,status:"quoted"};deposits.set(routeId,route);
      journal?.prepare("INSERT INTO deposit_routes VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'quoted', NULL, ?)").run(routeId,account,parsed.data.fromChainId.toString(),parsed.data.fromToken,sourceAmount.toString(),expectedUsdc.toString(),minimumUsdc.toString(),Number(deadline),nonce.toString(),Date.now());
      return {provider:"local-simulator",routeId,fromChainId:parsed.data.fromChainId,fromToken:parsed.data.fromToken,amount:parsed.data.amount,expectedUsdc:expectedUsdc.toString(),minimumUsdc:minimumUsdc.toString(),estimatedSeconds:2,domain:{...domain,chainId:domain.chainId.toString()},types:depositTypes,intent:depositToWire(intent)};
    } catch(error){return reply.code(409).send({error:publicError(error,"deposit route rejected")});}
  });
  app.post("/v1/deposit/execute",async(request,reply)=>{
    const parsed=depositExecuteSchema.safeParse(request.body);if(!parsed.success)return reply.code(400).send({error:"invalid deposit execution"});
    const route=deposits.get(parsed.data.routeId);if(!route)return reply.code(404).send({error:"deposit route not found"});
    try {if(recoverDepositSigner(domain,route.intent,parsed.data.userSignature)!==route.intent.account)return reply.code(401).send({error:"invalid deposit signature"});}
    catch{return reply.code(401).send({error:"invalid deposit signature"});}
    if(route.transaction)return {status:"deposited",routeId:parsed.data.routeId,transaction:route.transaction};
    if(!options.chain?.devFund||!token||!clearing||!provider||!sender)return reply.code(503).send({error:"live route adapter is not configured"});
    if(route.destinationTxHash){
      const existing=await provider.getTransactionReceipt(route.destinationTxHash);
      if(!existing)return reply.code(202).send({status:"submitted",routeId:parsed.data.routeId,transaction:{hash:route.destinationTxHash}});
      if(existing.status===1){const collateral=await clearing.collateralOf(route.intent.account);route.status="deposited";route.transaction={hash:route.destinationTxHash,blockNumber:existing.blockNumber,collateral:collateral.toString()};journal?.prepare("UPDATE deposit_routes SET status='deposited', updated_ms=? WHERE route_id=?").run(Date.now(),parsed.data.routeId);return {status:"deposited",routeId:parsed.data.routeId,expectedUsdc:route.expectedUsdc.toString(),transaction:route.transaction};}
    }
    if(Number(route.intent.deadline)*1_000<=Date.now())return reply.code(409).send({error:"deposit route expired"});
    journal?.prepare("UPDATE deposit_routes SET status='authorized', updated_ms=? WHERE route_id=?").run(Date.now(),parsed.data.routeId);route.status="authorized";
    try {
      const timestamp=await advanceLocalChainTime();
      await sender.submit(`deposit-mint:${route.intent.routeId}`,{to:options.chain.tokenAddress,data:token.interface.encodeFunctionData("mint",[route.intent.account,route.expectedUsdc])});
      const receipt=await sender.submit(`deposit:${route.intent.routeId}`,{to:options.chain.clearingAddress,data:clearing.interface.encodeFunctionData("depositWithAuthorization",[route.intent.account,route.expectedUsdc,timestamp-60,timestamp+600,route.intent.routeId,27,"0x"+"00".repeat(32),"0x"+"00".repeat(32)])});route.destinationTxHash=receipt.hash;journal?.prepare("UPDATE deposit_routes SET destination_tx=?, updated_ms=? WHERE route_id=?").run(receipt.hash,Date.now(),parsed.data.routeId);
      const collateral=await clearing.collateralOf(route.intent.account);route.status="deposited";route.transaction={hash:receipt.hash,blockNumber:receipt.blockNumber,collateral:collateral.toString()};
      journal?.prepare("UPDATE deposit_routes SET status='deposited', updated_ms=? WHERE route_id=?").run(Date.now(),parsed.data.routeId);return {status:"deposited",routeId:parsed.data.routeId,expectedUsdc:route.expectedUsdc.toString(),transaction:route.transaction};
    } catch(error){return reply.code(409).send({error:publicError(error,"deposit failed")});}
  });
  app.post("/v1/withdraw/prepare",async(request,reply)=>{const parsed=withdrawalPrepareSchema.safeParse(request.body);if(!parsed.success)return reply.code(400).send({error:"invalid withdrawal request"});try{const account=getAddress(parsed.data.account),recipient=getAddress(parsed.data.recipient??parsed.data.account),amount=parseUnits(parsed.data.amount,6);if(amount<=0n)throw new Error();const intent:WithdrawalIntent={account,recipient,amount,nonce:BigInt(parsed.data.nonce),deadline:BigInt(await chainTimestamp()+120)};return {domain:{...domain,chainId:domain.chainId.toString()},types:withdrawalTypes,intent:withdrawalToWire(intent)};}catch{return reply.code(400).send({error:"invalid withdrawal request"});}});
  app.post("/v1/withdraw/execute",async(request,reply)=>{const parsed=withdrawalExecuteSchema.safeParse(request.body);if(!parsed.success)return reply.code(400).send({error:"invalid signed withdrawal"});try{const intent:WithdrawalIntent={account:getAddress(parsed.data.intent.account),recipient:getAddress(parsed.data.intent.recipient),amount:BigInt(parsed.data.intent.amount),nonce:BigInt(parsed.data.intent.nonce),deadline:BigInt(parsed.data.intent.deadline)};if(Number(intent.deadline)*1_000<=Date.now()||!await validOwnerSignature(intent.account,TypedDataEncoder.hash(domain,withdrawalTypes,intent),parsed.data.userSignature,provider))return reply.code(401).send({error:"invalid withdrawal signature"});if(!clearing||!sender||!options.chain)return reply.code(503).send({error:"chain unavailable"});const receipt=await sender.submit(`withdraw:${intent.account}:${intent.nonce}`,{to:options.chain.clearingAddress,data:clearing.interface.encodeFunctionData("withdrawWithSignature",[intent.account,intent.recipient,intent.amount,intent.nonce,intent.deadline,parsed.data.userSignature])});if(!await settlementEvent(provider!,options.chain.clearingAddress,clearing.interface,receipt.hash,"Withdrawn",args=>String(args.account).toLowerCase()===intent.account.toLowerCase()&&BigInt(String(args.amount))===intent.amount))return reply.code(409).send({status:"resolution_required",error:"withdrawal not paid; inspect resolution state",transaction:{hash:receipt.hash,blockNumber:receipt.blockNumber}});return {status:"included",transaction:{hash:receipt.hash,blockNumber:receipt.blockNumber},collateral:(await clearing.collateralOf(intent.account)).toString()};}catch(error){return reply.code(409).send({error:publicError(error,"withdrawal failed")});}});
  app.post("/v1/nonce/cancel/prepare",async(request,reply)=>{const parsed=actionBaseSchema.safeParse(request.body);if(!parsed.success)return reply.code(400).send({error:"invalid cancellation request"});try{const intent:CancelIntent={account:getAddress(parsed.data.account),nonce:BigInt(parsed.data.nonce),deadline:BigInt(await chainTimestamp()+120)};return {domain:{...domain,chainId:domain.chainId.toString()},types:cancelTypes,intent:cancelToWire(intent)};}catch{return reply.code(400).send({error:"invalid cancellation request"});}});
  app.post("/v1/nonce/cancel/execute",async(request,reply)=>{const parsed=cancelExecuteSchema.safeParse(request.body);if(!parsed.success)return reply.code(400).send({error:"invalid signed cancellation"});try{const intent:CancelIntent={account:getAddress(parsed.data.intent.account),nonce:BigInt(parsed.data.intent.nonce),deadline:BigInt(parsed.data.intent.deadline)};if(Number(intent.deadline)*1_000<=Date.now()||!await validOwnerSignature(intent.account,TypedDataEncoder.hash(domain,cancelTypes,intent),parsed.data.userSignature,provider))return reply.code(401).send({error:"invalid cancellation signature"});if(!clearing||!sender||!options.chain)return reply.code(503).send({error:"chain unavailable"});const receipt=await sender.submit(`cancel:${intent.account}:${intent.nonce}`,{to:options.chain.clearingAddress,data:clearing.interface.encodeFunctionData("cancelNonceWithSignature",[intent.account,intent.nonce,intent.deadline,parsed.data.userSignature])});return {status:"included",transaction:{hash:receipt.hash,blockNumber:receipt.blockNumber}};}catch(error){return reply.code(409).send({error:publicError(error,"cancellation failed")});}});
  app.post("/v1/close/prepare",async(request,reply)=>{const parsed=closePrepareSchema.safeParse(request.body);if(!parsed.success)return reply.code(400).send({error:"invalid close request"});try{const intent:CloseIntent={account:getAddress(parsed.data.account),market:parsed.data.market==="BTC"?0:1,nonce:BigInt(parsed.data.nonce),deadline:BigInt(await chainTimestamp()+120)};return {domain:{...domain,chainId:domain.chainId.toString()},types:closeTypes,intent:closeToWire(intent)};}catch{return reply.code(400).send({error:"invalid close request"});}});
  app.post("/v1/close/execute",async(request,reply)=>{const parsed=closeExecuteSchema.safeParse(request.body);if(!parsed.success)return reply.code(400).send({error:"invalid signed close"});try{const intent:CloseIntent={account:getAddress(parsed.data.intent.account),market:parsed.data.intent.market,nonce:BigInt(parsed.data.intent.nonce),deadline:BigInt(parsed.data.intent.deadline)};if(Number(intent.deadline)*1_000<=Date.now()||!await validOwnerSignature(intent.account,TypedDataEncoder.hash(domain,closeTypes,intent),parsed.data.userSignature,provider))return reply.code(401).send({error:"invalid close signature"});if(!clearing||!sender||!provider||!options.chain)return reply.code(503).send({error:"chain unavailable"});const market=intent.market===0?"BTC":"ETH";let report:string;if(options.oracleSource){const observation=await settlementOracle(market);prices[market]=observation.snapshot;if(options.chain.devFund){const timestamp=await advanceLocalChainTime();report=AbiCoder.defaultAbiCoder().encode(["tuple(uint8 market,uint256 bid,uint256 ask,uint64 observedAt,uint64 validUntil)"],[[intent.market,observation.snapshot.bid,observation.snapshot.ask,BigInt(timestamp),BigInt(timestamp+60)]]);}else report=observation.report;}else{const timestamp=options.chain.devFund?await advanceLocalChainTime():Number(BigInt((await provider.send("eth_getBlockByNumber",["latest",false]) as {timestamp:string}).timestamp)),snapshot=prices[market];report=AbiCoder.defaultAbiCoder().encode(["tuple(uint8 market,uint256 bid,uint256 ask,uint64 observedAt,uint64 validUntil)"],[[intent.market,snapshot.bid,snapshot.ask,BigInt(timestamp),BigInt(timestamp+60)]]);}const adapter=new Contract(await clearing.oracle(),["function updateFee(bytes) view returns(uint256)"],provider),value=options.chain.devFund?0n:BigInt(await adapter.updateFee(report)),data=clearing.interface.encodeFunctionData("closePositionWithSignature",[intent.account,intent.market,intent.nonce,intent.deadline,report,parsed.data.userSignature]);if(!options.chain.devFund)await provider.call({from:sponsor!.address,to:options.chain.clearingAddress,data,value});const receipt=await sender.submit(`close:${intent.account}:${intent.market}:${intent.nonce}`,{to:options.chain.clearingAddress,data,value,gasLimit:1_500_000n});if(!await settlementEvent(provider,options.chain.clearingAddress,clearing.interface,receipt.hash,"PositionClosed",args=>String(args.account).toLowerCase()===intent.account.toLowerCase()&&Number(args.market)===intent.market))return reply.code(409).send({status:"resolution_required",error:"position not closed; inspect resolution state",transaction:{hash:receipt.hash,blockNumber:receipt.blockNumber}});const position=await clearing.positionOf(intent.account,intent.market);return {status:"included",transaction:{hash:receipt.hash,blockNumber:receipt.blockNumber},position:{size:position.size.toString(),entryPrice:position.entryPrice.toString()}};}catch(error){return reply.code(409).send({error:publicError(error,"close failed")});}});
  app.post("/v1/session/prepare",async(request,reply)=>{const parsed=sessionPrepareSchema.safeParse(request.body);if(!parsed.success)return reply.code(400).send({error:"invalid session request"});try{const account=getAddress(parsed.data.account),session=getAddress(parsed.data.session),now=await chainTimestamp();const grant:SessionGrant={account,session,marketMask:parsed.data.marketMask,maxTradeNotional:parseUnits(parsed.data.maxTradeAmount,6),maxCumulativeNotional:parseUnits(parsed.data.maxCumulativeAmount,6),maxFee:parseUnits(parsed.data.maxFee,6),validUntil:BigInt(now+parsed.data.durationSeconds),nonce:BigInt(parsed.data.nonce),deadline:BigInt(now+120)};if(grant.maxTradeNotional<=0n||grant.maxTradeNotional>grant.maxCumulativeNotional)throw new Error();return {domain:{...domain,chainId:domain.chainId.toString()},types:sessionGrantTypes,grant:sessionGrantToWire(grant)};}catch{return reply.code(400).send({error:"invalid session request"});}});
  app.post("/v1/session/execute",async(request,reply)=>{const parsed=sessionExecuteSchema.safeParse(request.body);if(!parsed.success)return reply.code(400).send({error:"invalid signed session"});try{const grant:SessionGrant={...parsed.data.grant,account:getAddress(parsed.data.grant.account),session:getAddress(parsed.data.grant.session),maxTradeNotional:BigInt(parsed.data.grant.maxTradeNotional),maxCumulativeNotional:BigInt(parsed.data.grant.maxCumulativeNotional),maxFee:BigInt(parsed.data.grant.maxFee),validUntil:BigInt(parsed.data.grant.validUntil),nonce:BigInt(parsed.data.grant.nonce),deadline:BigInt(parsed.data.grant.deadline)};if(Number(grant.deadline)*1_000<=Date.now()||!await validOwnerSignature(grant.account,TypedDataEncoder.hash(domain,sessionGrantTypes,grant),parsed.data.userSignature,provider))return reply.code(401).send({error:"invalid session signature"});if(!clearing||!sender||!options.chain)return reply.code(503).send({error:"chain unavailable"});const receipt=await sender.submit(`session:${grant.account}:${grant.session}:${grant.nonce}`,{to:options.chain.clearingAddress,data:clearing.interface.encodeFunctionData("grantSessionWithSignature",[grant,parsed.data.userSignature])});return {status:"active",session:grant.session,validUntil:grant.validUntil.toString(),transaction:{hash:receipt.hash,blockNumber:receipt.blockNumber}};}catch(error){return reply.code(409).send({error:publicError(error,"session failed")});}});
  app.post("/v1/orders/prepare",async(request,reply)=>{if(!admitQuoteWork(request,reply))return;const parsed=orderPrepareSchema.safeParse(request.body);if(!parsed.success)return reply.code(400).send({error:"invalid limit order"});try{prune();if(activeOrderCount()>=(options.maxRestingOrders??100_000))throw new Error("order capacity reached");const account=getAddress(parsed.data.account),{quote,versions}=await createQuote({market:parsed.data.market,side:parsed.data.side,amount:parsed.data.amount},false),limitPrice=parseUnits(parsed.data.limitPrice,6),maximumNotional=abs(quote.baseDelta)*limitPrice/BASE,maxFee=(maximumNotional*2n+9_999n)/10_000n,deadline=BigInt(versions.blockTimestamp+parsed.data.durationSeconds),intent:TradeIntent={account,market:parsed.data.market==="BTC"?0:1,baseDelta:quote.baseDelta,limitPrice,maxFee,nonce:BigInt(parsed.data.nonce),deadline,reduceOnly:parsed.data.reduceOnly},orderId=crypto.randomUUID(),now=Date.now();if(limitPrice<=0n)throw new Error("invalid limit price");const order:RestingOrder={orderId,intent,market:parsed.data.market,side:parsed.data.side,amount:parsed.data.amount,status:"prepared",createdAtMs:now,updatedAtMs:now};restingOrders.set(orderId,order);preparedOrderExpiries.schedule(orderId,now+300_000);return {orderId,domain:{...domain,chainId:domain.chainId.toString()},types:intentTypes,intent:intentToWire(intent),summary:{market:order.market,side:order.side,amount:order.amount,baseDelta:intent.baseDelta.toString(),limitPrice:intent.limitPrice.toString(),maxFee:intent.maxFee.toString(),expiresAtMs:Number(intent.deadline)*1_000}};}catch(error){return reply.code(409).send({error:publicError(error,"limit order rejected")});}});
  app.post("/v1/orders",async(request,reply)=>{const parsed=orderPlaceSchema.safeParse(request.body);if(!parsed.success)return reply.code(400).send({error:"invalid signed order"});const order=restingOrders.get(parsed.data.orderId);if(!order||order.status!=="prepared")return reply.code(404).send({error:"prepared order not found"});try{let valid=false;try{valid=recoverIntentSigner(domain,order.intent,parsed.data.userSignature)===order.intent.account;}catch{}if(!valid&&provider&&await provider.getCode(order.intent.account)!=="0x"){const wallet=new Contract(order.intent.account,["function isValidSignature(bytes32,bytes) view returns(bytes4)"],provider);valid=await wallet.isValidSignature(hashIntent(domain,order.intent),parsed.data.userSignature).then((value:string)=>value.toLowerCase()==="0x1626ba7e").catch(()=>false);}if(!valid)return reply.code(401).send({error:"invalid order signature"});order.userSignature=parsed.data.userSignature;order.status="open";order.updatedAtMs=Date.now();preparedOrderExpiries.cancel(order.orderId);limitBook.add(order.orderId,order.market,order.side,order.intent.limitPrice,Number(order.intent.deadline)*1_000);journal?.prepare("INSERT INTO resting_orders VALUES(?,?,?,?,?,?,?,?,?,?,?,?)").run(order.orderId,order.intent.account,order.market,order.side,order.amount,JSON.stringify(intentToWire(order.intent)),order.userSignature,order.status,order.createdAtMs,order.updatedAtMs,null,null);scheduleOrderCheck();return {orderId:order.orderId,status:order.status,intent:intentToWire(order.intent)};}catch{return reply.code(401).send({error:"invalid order signature"});}});
  app.get("/v1/orders/:address",async(request,reply)=>{let account:string;try{account=getAddress((request.params as {address:string}).address);}catch{return reply.code(400).send({error:"invalid account"});}return {items:[...restingOrders.values()].filter(order=>order.intent.account===account&&order.status!=="prepared").sort((a,b)=>b.createdAtMs-a.createdAtMs).map(order=>({orderId:order.orderId,market:order.market,side:order.side,amount:order.amount,baseDelta:order.intent.baseDelta.toString(),limitPrice:order.intent.limitPrice.toString(),maxFee:order.intent.maxFee.toString(),nonce:order.intent.nonce.toString(),expiresAtMs:Number(order.intent.deadline)*1_000,status:order.status,transactionHash:order.transactionHash,lastError:order.lastError}))};});
  app.post("/v1/orders/:orderId/cancel/prepare",async(request,reply)=>{const order=restingOrders.get((request.params as {orderId:string}).orderId);if(!order||!order.userSignature)return reply.code(404).send({error:"order not found"});const intent:CancelIntent={account:order.intent.account,nonce:order.intent.nonce,deadline:BigInt(await chainTimestamp()+120)};return {domain:{...domain,chainId:domain.chainId.toString()},types:cancelTypes,intent:cancelToWire(intent)};});
  app.post("/v1/orders/:orderId/cancel",async(request,reply)=>{const order=restingOrders.get((request.params as {orderId:string}).orderId),parsed=cancelExecuteSchema.safeParse(request.body);if(!order||!parsed.success)return reply.code(400).send({error:"invalid order cancellation"});try{const intent:CancelIntent={account:getAddress(parsed.data.intent.account),nonce:BigInt(parsed.data.intent.nonce),deadline:BigInt(parsed.data.intent.deadline)};if(intent.account!==order.intent.account||intent.nonce!==order.intent.nonce||Number(intent.deadline)*1_000<=Date.now()||!await validOwnerSignature(intent.account,TypedDataEncoder.hash(domain,cancelTypes,intent),parsed.data.userSignature,provider))return reply.code(401).send({error:"invalid cancellation signature"});if(!clearing||!sender||!options.chain)return reply.code(503).send({error:"chain unavailable"});const receipt=await sender.submit(`cancel-order:${order.orderId}`,{to:options.chain.clearingAddress,data:clearing.interface.encodeFunctionData("cancelNonceWithSignature",[intent.account,intent.nonce,intent.deadline,parsed.data.userSignature])});order.status="cancelled";limitBook.remove(order.orderId);order.updatedAtMs=Date.now();order.transactionHash=receipt.hash;journal?.prepare("UPDATE resting_orders SET status='cancelled',tx_hash=?,updated_ms=? WHERE order_id=?").run(receipt.hash,order.updatedAtMs,order.orderId);return {orderId:order.orderId,status:order.status,transaction:{hash:receipt.hash,blockNumber:receipt.blockNumber}};}catch(error){return reply.code(409).send({error:publicError(error,"cancellation failed")});}});
  app.post("/v1/quote",async(request,reply)=>{
    if(!admitQuoteWork(request,reply))return;
    const parsed=quoteRequestSchema.safeParse(request.body);
    if(!parsed.success)return reply.code(400).send({error:"invalid quote request"});
    try {return quoteToWire((await createQuote(parsed.data)).quote);} catch(error){return reply.code(options.oracleSource||options.hedgeRiskSource?503:409).send({error:publicError(error,"quote rejected")});}
  });
  app.post("/v1/close/quote",async(request,reply)=>{if(!admitQuoteWork(request,reply))return;const parsed=closeQuoteSchema.safeParse(request.body);if(!parsed.success)return reply.code(400).send({error:"invalid close quote request"});if(!clearing)return reply.code(503).send({error:"chain unavailable"});try{const account=getAddress(parsed.data.account),marketIndex=parsed.data.market==="BTC"?0:1,position=await clearing.positionOf(account,marketIndex),size=BigInt(position.size);if(size===0n)return reply.code(409).send({error:"position is already closed"});const side=size>0n?"sell":"buy",quote=(await createQuote({market:parsed.data.market,side,amount:"1"},true,-size,account)).quote;forcedReduceOnly.add(quote.quoteId);return quoteToWire(quote);}catch(error){return reply.code(503).send({error:publicError(error,"close quote rejected")});}});
  app.post("/v1/prepare",async(request,reply)=>{
    const parsed=intentRequestSchema.safeParse(request.body);
    if(!parsed.success)return reply.code(400).send({error:"invalid intent request"});
    const quote=quotes.get(parsed.data.quoteId);
    const versions=quoteVersions.get(parsed.data.quoteId);
    if(!quote||!versions||quote.expiresAtMs<=Date.now())return reply.code(409).send({error:"quote expired"});
    try {
      const requestedAccount=getAddress(parsed.data.account);
      const binding=quoteBindings.get(quote.quoteId);
      if(binding&&(binding.account!==requestedAccount||binding.nonce!==parsed.data.nonce))return reply.code(409).send({error:"quote already prepared"});
      const intent=makeIntent(quote,versions,parsed.data.account,parsed.data.nonce,parsed.data.reduceOnly);
      quoteBindings.set(quote.quoteId,{account:intent.account,nonce:parsed.data.nonce});
      preparedIntents.set(quote.quoteId,intent);
      return {domain:{...domain,chainId:domain.chainId.toString()},types:intentTypes,intent:intentToWire(intent),intentHash:hashIntent(domain,intent)};
    } catch{return reply.code(400).send({error:"invalid account or nonce"});}
  });
  app.post("/v1/approve",async(request,reply)=>{
    const parsed=approvalRequestSchema.safeParse(request.body);
    if(!parsed.success)return reply.code(400).send({error:"invalid signed intent"});
    const completed=completedSubmissions.get(parsed.data.quoteId);if(completed){if(completed.account.toLowerCase()===parsed.data.account.toLowerCase()&&completed.nonce===parsed.data.nonce&&completed.userSignature===parsed.data.userSignature)return completed.result;return reply.code(409).send({error:"quote already submitted"});}
    const active=activeSubmissions.get(parsed.data.quoteId);
    if(active){await active;const result=completedSubmissions.get(parsed.data.quoteId);if(result&&result.account.toLowerCase()===parsed.data.account.toLowerCase()&&result.nonce===parsed.data.nonce&&result.userSignature===parsed.data.userSignature)return result.result;return reply.code(409).send({error:"quote submission requires reconciliation or retry",retriable:true});}
    if(activeSubmissions.size>=(options.maxActiveQuotes??50_000))return reply.code(503).send({error:"submission capacity reached"});
    let completeSubmission!:()=>void;activeSubmissions.set(parsed.data.quoteId,new Promise<void>(resolve=>{completeSubmission=resolve;}));
    try{
    let quote=quotes.get(parsed.data.quoteId);
    let versions=quoteVersions.get(parsed.data.quoteId);
    if(!quote||!versions||quote.expiresAtMs<=Date.now())return reply.code(409).send({error:"quote expired"});
    const binding=quoteBindings.get(quote.quoteId);
    let requestedAccount:string;try{requestedAccount=getAddress(parsed.data.account);}catch{return reply.code(400).send({error:"invalid account"});}
    if(!binding||binding.account!==requestedAccount||binding.nonce!==parsed.data.nonce)return reply.code(409).send({error:"quote preparation mismatch"});
    let intent:TradeIntent;
    try { intent=preparedIntents.get(quote.quoteId)!;if(!intent||intent.account!==requestedAccount||intent.nonce!==BigInt(parsed.data.nonce))throw new Error();let signer:string|undefined;try{signer=recoverIntentSigner(domain,intent,parsed.data.userSignature);}catch{}let accountAuthorized=signer===intent.account;if(!accountAuthorized&&provider&&await provider.getCode(intent.account)!=="0x"){const wallet=new Contract(intent.account,["function isValidSignature(bytes32,bytes) view returns(bytes4)"],provider);accountAuthorized=await wallet.isValidSignature(hashIntent(domain,intent),parsed.data.userSignature,{blockTag:versions.blockNumber}).then((value:string)=>value.toLowerCase()==="0x1626ba7e").catch(()=>false);}if(!accountAuthorized){if(!clearing||!signer)throw new Error();const session=await clearing.sessions(signer,{blockTag:versions.blockNumber});if(getAddress(session.account)!==intent.account||BigInt(session.validUntil)<intent.deadline||(Number(session.marketMask)&(1<<intent.market))===0||BigInt(session.maxFee)<intent.maxFee)throw new Error();} }
    catch{return reply.code(401).send({error:"invalid user signature"});}
    const originalId=quote.quoteId,intentHash=hashIntent(domain,intent),minimumBudget=options.minSettlementInclusionSeconds??4;
    let approval!:MakerApproval,report="0x",selected!:Array<{digest:string;signer:string;signature:string}>,executionData:string|undefined,oracleFee=0n;
    // Optimistic reads precede a synchronous durable admission section. Remote
    // quorum and simulation run after publication and outside the lock.
    for(let attempt=0,conflicts=0;attempt<2;attempt++){
      let reservationRevision=pending.revision;
      let reportData=quoteReports.get(originalId);
      {
        try{
          const refreshed=await createQuote({market:quote.market,side:quote.side,amount:formatUsdc(quote.notional)},false,intent.baseDelta,intent.account,originalId);
          if((intent.baseDelta>0n&&refreshed.quote.expectedPrice>intent.limitPrice)||(intent.baseDelta<0n&&refreshed.quote.expectedPrice<intent.limitPrice)||refreshed.quote.fee>intent.maxFee)return reply.code(409).send({error:"price moved beyond signed protection"});
          quote={...refreshed.quote,quoteId:originalId};versions=refreshed.versions;reportData=refreshed.oracleReport;reservationRevision=refreshed.reservationRevision;
        }catch(error){return reply.code(503).send({error:publicError(error,"fresh settlement price unavailable")});}
      }
      prune();const reportExpiry=reportData?.validUntil??versions.blockTimestamp+30,approvalDeadline=BigInt(Math.min(Number(intent.deadline),versions.blockTimestamp+30,reportExpiry));
      if(Number(approvalDeadline)<=versions.blockTimestamp)return reply.code(503).send({error:"fresh settlement proof lacks inclusion time",retriable:true});
      report=reportData?.report??"0x";
      if(provider&&report==="0x"){
        const timestamp=options.chain?.devFund?await advanceLocalChainTime():Number(BigInt((await provider.send("eth_getBlockByNumber",["latest",false]) as {timestamp:string}).timestamp));
        report=AbiCoder.defaultAbiCoder().encode(["tuple(uint8 market,uint256 bid,uint256 ask,uint64 observedAt,uint64 validUntil)"],[[intent.market,quote.snapshot.bid,quote.snapshot.ask,BigInt(timestamp),BigInt(timestamp+60)]]);
      }
      const oracleReportHash=report==="0x"?keccak256(toUtf8Bytes(JSON.stringify({market:quote.market,bid:quote.snapshot.bid.toString(),ask:quote.snapshot.ask.toString(),observedAtMs:quote.snapshot.observedAtMs}))):keccak256(report);
      approval={intentHash,executionPrice:quote.expectedPrice,impactCharge:quote.impactCharge,fee:quote.fee,oracleReportHash,deadline:approvalDeadline,leaderEpoch:versions.leaderEpoch,signerSetVersion:versions.signerSetVersion,policyVersion:versions.policyVersion};
      const digest=hashApproval(domain,approval),approverPayload={domain:{...domain,chainId:domain.chainId.toString()},intent:intentToWire(intent),userSignature:parsed.data.userSignature,approval:approvalToWire(approval),quote:quoteToWire(quote),report,oracleAgeMs:Date.now()-quote.snapshot.observedAtMs};
      let grossItem:GrossReservation={market:intent.market as 0|1,baseDelta:intent.baseDelta,reduceOnly:intent.reduceOnly,deadline:Number(approval.deadline),makerDebit:2n*BigInt(quote.notional)};
      let grossSnapshot:{blockNumber:number;blockTimestamp:number;books:[ExposureBook,ExposureBook];states:[ExposureMarket,ExposureMarket];position:{size:bigint;entryPrice:bigint;lastFundingIndex:bigint};netLimits:[bigint,bigint];backing:bigint;floor:bigint;clock:Awaited<ReturnType<typeof finalizedClock>>}|undefined;
      if(clearing&&provider){
        const blockNumber=Number(BigInt(await provider.send("eth_blockNumber",[]))),block=await provider.getBlock(blockNumber);if(!block)return reply.code(503).send({error:"gross reservation snapshot unavailable"});
        const [btcBook,ethBook,btcRaw,ethRaw,positionRaw,btcLimit,ethLimit,backing,floor,clock]=await Promise.all([clearing.exposureState(0,{blockTag:blockNumber}),clearing.exposureState(1,{blockTag:blockNumber}),clearing.markets(0,{blockTag:blockNumber}),clearing.markets(1,{blockTag:blockNumber}),clearing.positionOf(intent.account,intent.market,{blockTag:blockNumber}),clearing.marketLimitWord(0,{blockTag:blockNumber}),clearing.marketLimitWord(1,{blockTag:blockNumber}),clearing.makerBacking({blockTag:blockNumber}),clearing.baseRiskCapitalTarget({blockTag:blockNumber}),finalizedClock(provider,blockNumber,block.timestamp)]);
        const state=(value:typeof btcRaw):ExposureMarket=>({aggregateBase:BigInt(value.aggregateBase),fundingIndex:BigInt(value.fundingIndex),fundingTime:BigInt(value.fundingTime),lastPriceTime:BigInt(value.lastPriceTime),lastBid:BigInt(value.lastBid),lastAsk:BigInt(value.lastAsk),enabled:Boolean(value.enabled)}),position={size:BigInt(positionRaw.size),entryPrice:BigInt(positionRaw.entryPrice),lastFundingIndex:BigInt(positionRaw.lastFundingIndex)};
        grossSnapshot={blockNumber,blockTimestamp:block.timestamp,books:[btcBook,ethBook],states:[state(btcRaw),state(ethRaw)],position,netLimits:[BigInt(btcLimit),BigInt(ethLimit)],backing:BigInt(backing),floor:BigInt(floor),clock};
      }
      const releaseReservation=await acquireReservationLock();
      try{
      prune();
      if(pending.revision!==reservationRevision){if(++conflicts>=8)return reply.code(503).send({error:"admission inventory changed; request a fresh quote",retriable:true});attempt--;continue;}
      if(grossSnapshot){
        const {blockNumber,blockTimestamp,books,states,position,netLimits,backing,floor,clock}=grossSnapshot;
        if(clock)finalizeReservations(clock.block,clock.timestamp,clock.hash);
        const asks:[bigint,bigint]=[BigInt(states[0].lastAsk),BigInt(states[1].lastAsk)];asks[intent.market]=quote.snapshot.ask;
        const other=1-intent.market,otherState=states[other],priorGross=grossReservations.bounds(quote.quoteId)[other];if(priorGross.longBase+priorGross.shortBase>0n&&(Number(otherState.lastPriceTime)===0||blockTimestamp-Number(otherState.lastPriceTime)>15))return reply.code(503).send({error:"outstanding gross risk requires fresh cross-market price"});
        const net:[bigint,bigint]=states.map(state=>BigInt(state.aggregateBase)*(BigInt(state.lastBid)+BigInt(state.lastAsk))/2n/BASE) as [bigint,bigint];
        const capitalMarket={...states[intent.market],lastBid:quote.snapshot.bid,lastAsk:quote.snapshot.ask,lastPriceTime:BigInt(Math.floor(quote.snapshot.observedAtMs/1000))};
        grossItem={...grossItem,makerDebit:pendingMakerDebit({position,market:capitalMarket,delta:intent.baseDelta,executionPrice:approval.executionPrice,timestamp:BigInt(blockTimestamp),deadline:approval.deadline,netLimit:netLimits[intent.market]})};
        if(!grossReservations.admit(quote.quoteId,grossItem,books,asks,blockNumber,{net,netLimits,backing,floor}))return reply.code(409).send({error:"outstanding approvals exceed gross, net, stress, side or capital capacity"});
      }else {const timestamp=Math.floor(Date.now()/1000);finalizeReservations(timestamp,timestamp);}
      if(!grossReservations.get(quote.quoteId)&&grossReservations.size>=(options.maxActiveQuotes??50_000))return reply.code(503).send({error:"gross reservation capacity reached"});
      // Persist and reserve before signatures can escape, even if the quorum
      // response is lost. Failed admission retains conservative risk to expiry.
      journal?.exec("BEGIN IMMEDIATE");try{
      journal?.prepare("INSERT OR IGNORE INTO approval_artifacts VALUES(?,?,?,?)").run(digest,quote.quoteId,JSON.stringify(approverPayload),Date.now());
      journal?.prepare("INSERT INTO commitments VALUES (?, ?, ?, ?, 'reserved', ?, ?, ?, NULL, ?) ON CONFLICT(quote_id) DO UPDATE SET expires_ms=MAX(expires_ms,excluded.expires_ms),intent_json=excluded.intent_json,user_signature=excluded.user_signature,approval_json=excluded.approval_json,updated_ms=excluded.updated_ms").run(quote.quoteId,quote.market,quote.delta.toString(),Number(intent.deadline)*1_000,JSON.stringify(intentToWire(intent)),parsed.data.userSignature,JSON.stringify(approvalToWire(approval)),Date.now());
      if(journal)persistGross(journal,quote.quoteId,grossItem);
      journal?.exec("COMMIT");}catch(error){journal?.exec("ROLLBACK");throw error;}
      grossReservations.reserve(quote.quoteId,grossItem);
      pending.add(quote.quoteId,{market:quote.market,delta:quote.delta,expiresAtMs:Number(intent.deadline)*1_000});marketReadCache=undefined;
      }finally{releaseReservation();}
      const responses=await collectApprovals(digest,approverPayload),approvals=responses.filter((item):item is PromiseFulfilledResult<{digest:string;signer:string;signature:string}>=>item.status==="fulfilled").map(item=>item.value),distinct=new Map(approvals.map(item=>[item.signer.toLowerCase(),item]));
      if(distinct.size<2)return reply.code(503).send({error:"approver quorum unavailable",details:options.chain?.devFund||process.env.NODE_ENV==="test"?responses.filter(item=>item.status==="rejected").map(item=>String(item.reason)):undefined});
      selected=[...distinct.values()].slice(0,2);
      const currentChainTime=provider?await chainTimestamp():versions.blockTimestamp;
      if(Number(approval.deadline)-currentChainTime<minimumBudget){if(attempt===1)return reply.code(503).send({error:"settlement proof lacks safe inclusion budget",retriable:true});continue;}
      executionData=clearing?.interface.encodeFunctionData("executeTrade",[intent,approval,report,parsed.data.userSignature,selected[0].signature,selected[1].signature]);
      if(provider&&clearing&&sponsor&&!options.chain?.devFund){
        try{
          const oracleAddress=await clearing.oracle(),adapter=new Contract(oracleAddress,["function updateFee(bytes) view returns(uint256)"],provider);
          oracleFee=BigInt(await adapter.updateFee(report).catch(()=>0n));
          await provider.call({from:sponsor.address,to:options.chain!.clearingAddress,data:executionData,value:oracleFee});
        }catch(error){if(attempt===0&&staleOracleFailure(error))continue;return reply.code(409).send({error:"settlement simulation failed",retriable:staleOracleFailure(error),details:process.env.NODE_ENV==="test"?errorText(error):undefined});}
      }
      break;
    }
      journal?.prepare("INSERT INTO commitments VALUES (?, ?, ?, ?, 'reserved', ?, ?, ?, NULL, ?) ON CONFLICT(quote_id) DO UPDATE SET status='reserved', intent_json=excluded.intent_json, user_signature=excluded.user_signature, approval_json=excluded.approval_json, updated_ms=excluded.updated_ms").run(quote.quoteId,quote.market,quote.delta.toString(),Number(intent.deadline)*1_000,JSON.stringify(intentToWire(intent)),parsed.data.userSignature,JSON.stringify(approvalToWire(approval)),Date.now());
      if(!pending.has(quote.quoteId)){pending.add(quote.quoteId,{market:quote.market,delta:quote.delta,expiresAtMs:Number(approval.deadline)*1_000});marketReadCache=undefined;scheduleStreamPublish();}
      journal?.prepare("UPDATE commitments SET status='approved', updated_ms=? WHERE quote_id=?").run(Date.now(),quote.quoteId);
    let transaction:undefined|{hash:string;blockNumber:number;collateral:string;position:{size:string;entryPrice:string;lastFundingIndex:string}};
    if(clearing&&token&&provider&&options.chain&&sender){
      try {
        if(options.chain.devFund&&BigInt(await clearing.collateralOf(intent.account))<2_000n*1_000_000n){
          const amount=10_000n*1_000_000n,depositNonce=keccak256(toUtf8Bytes(`autofund:${quote.quoteId}`)),timestamp=await advanceLocalChainTime();
          await sender.submit(`autofund-mint:${quote.quoteId}`,{to:options.chain.tokenAddress,data:token.interface.encodeFunctionData("mint",[intent.account,amount])});
          await sender.submit(`autofund:${quote.quoteId}`,{to:options.chain.clearingAddress,data:clearing.interface.encodeFunctionData("depositWithAuthorization",[intent.account,amount,timestamp-60,timestamp+600,depositNonce,27,"0x"+"00".repeat(32),"0x"+"00".repeat(32)])});
        }
        const receipt=await sender.submit(`trade:${quote.quoteId}`,{to:options.chain.clearingAddress,data:executionData??clearing.interface.encodeFunctionData("executeTrade",[intent,approval,report,parsed.data.userSignature,selected[0].signature,selected[1].signature]),value:oracleFee,gasLimit:2_000_000n});quoteSnapshotCache=undefined;marketReadCache=undefined;journal?.prepare("UPDATE commitments SET status='submitted', tx_hash=?, updated_ms=? WHERE quote_id=?").run(receipt.hash,Date.now(),quote.quoteId);
        if(!await settlementEvent(provider,options.chain.clearingAddress,clearing.interface,receipt.hash,"TradeExecuted",args=>String(args.intentHash).toLowerCase()===intentHash.toLowerCase())){journal?.prepare("UPDATE commitments SET status='ambiguous',updated_ms=? WHERE quote_id=?").run(Date.now(),quote.quoteId);return reply.code(409).send({status:await clearing.resolutionRequired()?"resolution_required":"ambiguous",error:"transaction included without the authorized trade; reconcile before retrying",transaction:{hash:receipt.hash,blockNumber:receipt.blockNumber}});}
        const collateral=await clearing.collateralOf(intent.account); const position=await clearing.positionOf(intent.account,intent.market);
        transaction={hash:receipt.hash,blockNumber:receipt.blockNumber,collateral:collateral.toString(),position:{size:position.size.toString(),entryPrice:position.entryPrice.toString(),lastFundingIndex:position.lastFundingIndex.toString()}};
        journal?.prepare("UPDATE commitments SET status='included', updated_ms=? WHERE quote_id=?").run(Date.now(),quote.quoteId);
        if(pending.delete(quote.quoteId))settled[quote.market]+=quote.delta;
        const filledAt=Date.now();flowRisk.record(quote.market,{side:quote.side,price:quote.expectedPrice,notional:quote.notional,atMs:filledAt});
        journal?.prepare("INSERT OR IGNORE INTO flow_fills VALUES (?,?,?,?,?,?)").run(quote.quoteId,quote.market,quote.side,quote.expectedPrice.toString(),quote.notional.toString(),filledAt);
        journal?.prepare("DELETE FROM flow_fills WHERE filled_ms<?").run(filledAt-240_000);
        marketReadCache=undefined;scheduleStreamPublish();
      } catch(error){return reply.code(409).send({error:publicError(error,"chain submission failed")});}
    }
    const result={domain:{...domain,chainId:domain.chainId.toString()},intent:intentToWire(intent),userSignature:parsed.data.userSignature,approval:approvalToWire(approval),approvals:selected,quote:quoteToWire(quote),transaction};
    if(completedSubmissions.size>=(options.maxActiveQuotes??50_000))completedSubmissions.delete(completedSubmissions.keys().next().value!);
    completedSubmissions.set(quote.quoteId,{account:intent.account,nonce:intent.nonce.toString(),userSignature:parsed.data.userSignature,result,expiresAtMs:Date.now()+300_000});return result;
    }finally{activeSubmissions.delete(parsed.data.quoteId);completeSubmission();}
  });
  async function checkRestingOrders(){
    if(checkingOrders)return;checkingOrders=true;
    try{
      for(const id of limitBook.takeExpired()){const order=restingOrders.get(id);if(!order||order.status!=="open")continue;order.status="expired";order.updatedAtMs=Date.now();journal?.prepare("UPDATE resting_orders SET status='expired',updated_ms=? WHERE order_id=?").run(order.updatedAtMs,order.orderId);}
      const candidates=[...limitBook.takeMarketable("BTC",prices.BTC.bid,prices.BTC.ask,16),...limitBook.takeMarketable("ETH",prices.ETH.bid,prices.ETH.ask,16)];
      for(const id of candidates){const order=restingOrders.get(id);
      if(!order||order.status!=="open"||!order.userSignature)continue;
      if(clearing&&await clearing.nonceUsed(order.intent.account,order.intent.nonce).catch(()=>false)){order.status=order.transactionHash?"filled":"cancelled";order.updatedAtMs=Date.now();journal?.prepare("UPDATE resting_orders SET status=?,updated_ms=? WHERE order_id=?").run(order.status,order.updatedAtMs,order.orderId);continue;}
      try{
        const snapshot=prices[order.market],mid=(snapshot.bid+snapshot.ask)/2n,notional=abs(order.intent.baseDelta)*mid/BASE;if(notional<=0n)continue;
        let {quote}=await createQuote({market:order.market,side:order.side,amount:formatUsdc(notional)},false);const indicativeEligible=order.side==="buy"?quote.expectedPrice<=order.intent.limitPrice:quote.expectedPrice>=order.intent.limitPrice;if(!indicativeEligible){limitBook.add(order.orderId,order.market,order.side,order.intent.limitPrice,Number(order.intent.deadline)*1_000);continue;}
        ({quote}=await createQuote({market:order.market,side:order.side,amount:formatUsdc(notional)},true));quote.baseDelta=order.intent.baseDelta;quote.delta=order.side==="buy"?notional:-notional;quote.notional=notional;
        const eligible=order.side==="buy"?quote.expectedPrice<=order.intent.limitPrice:quote.expectedPrice>=order.intent.limitPrice;if(!eligible){limitBook.add(order.orderId,order.market,order.side,order.intent.limitPrice,Number(order.intent.deadline)*1_000);continue;}
        preparedIntents.set(quote.quoteId,order.intent);quoteBindings.set(quote.quoteId,{account:order.intent.account,nonce:order.intent.nonce.toString()});order.status="executing";order.updatedAtMs=Date.now();journal?.prepare("UPDATE resting_orders SET status='executing',updated_ms=? WHERE order_id=?").run(order.updatedAtMs,order.orderId);
        const result=await app.inject({method:"POST",url:"/v1/approve",payload:{quoteId:quote.quoteId,account:order.intent.account,nonce:order.intent.nonce.toString(),userSignature:order.userSignature}}),body=result.json();preparedIntents.delete(quote.quoteId);
        if(result.statusCode===200&&body.transaction){order.status="filled";order.transactionHash=body.transaction.hash;order.lastError=undefined;orderCheckQueued=true;}else{order.status="open";limitBook.add(order.orderId,order.market,order.side,order.intent.limitPrice,Number(order.intent.deadline)*1_000);const detail=Array.isArray(body.details)?body.details.join("; "):undefined;order.lastError=detail?`${body.error}: ${detail}`:body.error??`execution returned ${result.statusCode}`;}
        order.updatedAtMs=Date.now();journal?.prepare("UPDATE resting_orders SET status=?,updated_ms=?,tx_hash=?,last_error=? WHERE order_id=?").run(order.status,order.updatedAtMs,order.transactionHash??null,order.lastError??null,order.orderId);
      }catch(error){order.status="open";limitBook.add(order.orderId,order.market,order.side,order.intent.limitPrice,Number(order.intent.deadline)*1_000);order.updatedAtMs=Date.now();order.lastError=publicError(error,"execution unavailable");journal?.prepare("UPDATE resting_orders SET status='open',updated_ms=?,last_error=? WHERE order_id=?").run(order.updatedAtMs,order.lastError,order.orderId);}
    }}finally{checkingOrders=false;if(orderCheckQueued){orderCheckQueued=false;scheduleOrderCheck();}}
  }
  app.addHook("onReady",async()=>{if(recoveredCommitments.length){const versions=await readProtocolVersions();for(const recovered of recoveredCommitments)quoteVersions.set(recovered.quote.quoteId,versions);}await sender?.reconcile();senderReconcileTimer=setInterval(()=>{if(sender&&!senderReconciliation)senderReconciliation=sender.reconcile().catch(()=>{}).finally(()=>{senderReconciliation=undefined;});},5000);senderReconcileTimer.unref();unsubscribeOracle=options.oracleSource?.subscribe?.(()=>{scheduleStreamPublish();scheduleOrderCheck();});await options.oracleSource?.start?.();orderReconcileTimer=setInterval(()=>scheduleOrderCheck(),30_000);orderReconcileTimer.unref();heartbeatTimer=setInterval(()=>{for(const client of marketClients)client.response.write(": heartbeat\n\n");},15_000);heartbeatTimer.unref();});
  app.addHook("onClose",async()=>{if(senderReconcileTimer)clearInterval(senderReconcileTimer);if(orderTimer)clearTimeout(orderTimer);if(orderReconcileTimer)clearInterval(orderReconcileTimer);if(streamTimer)clearTimeout(streamTimer);if(heartbeatTimer)clearInterval(heartbeatTimer);unsubscribeOracle?.();for(const client of marketClients)client.response.end();await options.oracleSource?.close?.();await senderReconciliation;provider?.destroy();journal?.close();});
  return app;
}
