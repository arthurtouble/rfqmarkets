import Fastify from "fastify";
import type { ServerResponse } from "node:http";
import cors from "@fastify/cors";
import { DatabaseSync } from "node:sqlite";
import { AbiCoder, Contract, JsonRpcProvider, Wallet, getAddress, keccak256, parseUnits, recoverAddress, toUtf8Bytes } from "ethers";
import { z } from "zod";
import { clearingApiAbi } from "../../../packages/shared/src/abi.js";
import { approvalToWire, cancelToWire, cancelTypes, closeToWire, closeTypes, depositToWire, depositTypes, DOMAIN_NAME, DOMAIN_VERSION, hashApproval, hashIntent, intentToWire, intentTypes, recoverCancelSigner, recoverCloseSigner, recoverDepositSigner, recoverIntentSigner, recoverSessionGrantSigner, recoverWithdrawalSigner, sessionGrantToWire, sessionGrantTypes, withdrawalToWire, withdrawalTypes, type CancelIntent, type CloseIntent, type DepositIntent, type MakerApproval, type SessionGrant, type SigningDomain, type TradeIntent, type WithdrawalIntent } from "../../../packages/shared/src/eip712.js";
import { BASE, constructQuote, formatUsdc, marginRate, parseUsdc, quoteRequestSchema, type Exposure, type PriceSnapshot, type PricingParameters, type Quote } from "../../../packages/shared/src/policy.js";
import { quoteToWire } from "../../../packages/shared/src/wire.js";
import { DurableSender } from "./sender.js";
import type { OracleSource } from "./oracle.js";
import { hedgeAdmission, type HedgeRiskSnapshot, type HedgeRiskSource } from "../../../packages/shared/src/hedge-risk.js";
import { LimitTriggerBook } from "./limit-book.js";

export interface ApiOptions {
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
  maxRestingOrders?:number;
  hedgeRiskSource?:HedgeRiskSource;
}

const intentRequestSchema = z.object({ quoteId:z.string().uuid(), account:z.string(), nonce:z.string().regex(/^\d+$/) });
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
function adaptiveSpreadBps(snapshot:PriceSnapshot){return BigInt(Math.min(50,Math.max(2,2+Math.ceil((snapshot.volatilityBps??0)/5))));}

export function buildApi(options: ApiOptions = {}) {
  const app = Fastify({ logger:false, bodyLimit:16_384 });
  app.register(cors, { origin:options.corsOrigin ?? "http://127.0.0.1:4173" });
  const settled:Exposure = { BTC:0n, ETH:0n };
  const pending:Array<{quoteId:string;market:"BTC"|"ETH";delta:bigint;expiresAtMs:number}> = [];
  const journal=options.journalPath?new DatabaseSync(options.journalPath):undefined;
  journal?.exec("PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS commitments (quote_id TEXT PRIMARY KEY, market TEXT NOT NULL, delta TEXT NOT NULL, expires_ms INTEGER NOT NULL, status TEXT NOT NULL, intent_json TEXT NOT NULL, user_signature TEXT NOT NULL, approval_json TEXT, tx_hash TEXT, updated_ms INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS deposit_routes (route_id TEXT PRIMARY KEY, account TEXT NOT NULL, from_chain TEXT NOT NULL, from_token TEXT NOT NULL, source_amount TEXT NOT NULL, expected_usdc TEXT NOT NULL, minimum_usdc TEXT NOT NULL, deadline INTEGER NOT NULL, nonce TEXT NOT NULL, status TEXT NOT NULL, destination_tx TEXT, updated_ms INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS resting_orders (order_id TEXT PRIMARY KEY, account TEXT NOT NULL, market TEXT NOT NULL, side TEXT NOT NULL, amount TEXT NOT NULL, intent_json TEXT NOT NULL, user_signature TEXT NOT NULL, status TEXT NOT NULL, created_ms INTEGER NOT NULL, updated_ms INTEGER NOT NULL, tx_hash TEXT, last_error TEXT)");
  for(const row of journal?.prepare("SELECT quote_id, market, delta, expires_ms FROM commitments WHERE status IN ('reserved','approved','submitted') AND expires_ms > ?").all(Date.now())??[]){const item=row as {quote_id:string;market:"BTC"|"ETH";delta:string;expires_ms:number};pending.push({quoteId:item.quote_id,market:item.market,delta:BigInt(item.delta),expiresAtMs:item.expires_ms});}
  const quotes = new Map<string,Quote>();
  const quoteReports = new Map<string,{report:string;validUntil:number}>();
  const quoteVersions = new Map<string,ProtocolVersions>();
  const quoteBindings = new Map<string,{account:string;nonce:string}>();
  const preparedIntents=new Map<string,TradeIntent>();
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
  const provider=options.chain?new JsonRpcProvider(options.chain.rpcUrl):undefined;
  if(provider&&options.chain?.devFund)provider.pollingInterval=50;
  const sponsor=provider&&options.chain?new Wallet(options.chain.sponsorPrivateKey,provider):undefined;
  const sender=provider&&sponsor?new DurableSender(provider,sponsor,journal):undefined;
  const clearing=options.chain&&provider?new Contract(options.chain.clearingAddress,clearingApiAbi,provider):undefined;
  const token=options.chain&&provider?new Contract(options.chain.tokenAddress,["function mint(address,uint256)"],provider):undefined;
  const domain:SigningDomain = {
    name:DOMAIN_NAME, version:DOMAIN_VERSION, chainId:options.chainId ?? 31_337n,
    verifyingContract:getAddress(options.verifyingContract ?? "0x0000000000000000000000000000000000000001"),
  };
  const localDevMode=Boolean(options.chain?.devFund&&domain.chainId===31_337n&&options.chain.rpcUrl&&["127.0.0.1","localhost","::1"].includes(new URL(options.chain.rpcUrl).hostname));
  if(options.chain?.devFund&&!localDevMode)throw new Error("development funding requires local chain 31337 on a loopback RPC");
  let localAdvance:Promise<number>|undefined,lastLocalAdvanceAt=0,lastLocalTimestamp=0;
  let quoteSnapshotCache:{at:number;blockNumber:number;promise:Promise<{blockNumber:number;values:any[]}>}|undefined;
  let marketReadCache:{at:number;promise:Promise<any>}|undefined;
  let orderTimer:ReturnType<typeof setTimeout>|undefined,orderReconcileTimer:ReturnType<typeof setInterval>|undefined,checkingOrders=false,orderCheckQueued=false;
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
  async function hedgeRisk():Promise<HedgeRiskSnapshot|undefined>{if(!options.hedgeRiskSource)return undefined;try{const value=await options.hedgeRiskSource.latest();if(!value.observedAtMs||Date.now()-value.observedAtMs>3_000)throw new Error("stale hedge health");return value;}catch{return {observedAtMs:0,healthy:false,indexedBlock:-1,markets:{BTC:{mode:"reduce_only",gapNotional:"0",bandUsdc:"0"},ETH:{mode:"reduce_only",gapNotional:"0",bandUsdc:"0"}}};}}

  function prune(now=Date.now()) {
    for (let index=pending.length-1; index>=0; index--) if (pending[index].expiresAtMs<=now) pending.splice(index,1);
    for (const [id,quote] of quotes) if (quote.expiresAtMs+60_000<=now) { quotes.delete(id); quoteReports.delete(id); quoteVersions.delete(id); quoteBindings.delete(id); }
    for(const [id,order] of restingOrders)if(order.status==="prepared"&&order.createdAtMs+300_000<=now)restingOrders.delete(id);
  }
  const activeOrderCount=()=>{let count=0;for(const order of restingOrders.values())if(order.status==="prepared"||order.status==="open"||order.status==="executing")count++;return count;};
  function makeIntent(quote:Quote,versions:ProtocolVersions,account:string,nonce:string):TradeIntent {
    const prepared=preparedIntents.get(quote.quoteId);if(prepared)return prepared;
    const reportExpiry=quoteReports.get(quote.quoteId)?.validUntil??versions.blockTimestamp+30,deadline=Math.min(versions.blockTimestamp+30,reportExpiry);
    return { account:getAddress(account),market:quote.market==="BTC"?0:1,baseDelta:quote.baseDelta,limitPrice:quote.worstPrice,maxFee:quote.fee,nonce:BigInt(nonce),deadline:BigInt(deadline),reduceOnly:false };
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
        const storedIndex=chain?BigInt(chain.fundingIndex):0n,fundingTime=chain?Number(chain.fundingTime):Math.floor(now/1_000),elapsed=BigInt(Math.min(7*24*60*60,Math.max(0,(block?.timestamp??Math.floor(now/1_000))-fundingTime)));
        const projectedFundingIndex=storedIndex+mid*fundingApr*elapsed/(RATE*YEAR);
        result[name]={market:name,bid:snapshot.bid.toString(),ask:snapshot.ask.toString(),mid:mid.toString(),observedAtMs:snapshot.observedAtMs,source:snapshot.source??"configured",volatilityBps:snapshot.volatilityBps??0,baseSpreadBps:Number(adaptiveSpreadBps(snapshot)),aggregateBase:aggregateBase.toString(),fundingApr:fundingApr.toString(),fundingIndex:storedIndex.toString(),projectedFundingIndex:projectedFundingIndex.toString(),fundingTime,lastPriceTime:chain?Number(chain.lastPriceTime):0,enabled:chain?Boolean(chain.enabled):true,maxTradeNotional:limits.maxTradeNotional.toString(),maxMarketNotional:limits.maxMarketNotional.toString()};
      }
      const operational=await hedgeRisk();for(const name of ["BTC","ETH"] as const){const item=result[name] as Record<string,unknown>,mode=operational?.markets[name].mode??"normal",admission=hedgeAdmission(mode,settled[name],0n,BigInt(item.maxTradeNotional as string));item.riskMode=mode;item.operatingMaxTradeNotional=admission.maxTradeNotional.toString();item.canBuy=admission.canBuy;item.canSell=admission.canSell;}
      prune(now);const pendingEnvelope:{market:"BTC"|"ETH";delta:string}[]=[];for(const name of ["BTC","ETH"] as const){let low=0n,high=0n;for(const item of pending)if(item.market===name){if(item.delta<0n)low+=item.delta;else high+=item.delta;}if(low)pendingEnvelope.push({market:name,delta:low.toString()});if(high)pendingEnvelope.push({market:name,delta:high.toString()});}
      return {blockNumber,serverTimeMs:now,markets:result,pricing:{settled:{BTC:settled.BTC.toString(),ETH:settled.ETH.toString()},pending:pendingEnvelope,baseSpreadBps:2,feeBps:2,toleranceBps:8}};
    })();marketReadCache={at:now,promise};try{return await promise;}catch(error){marketReadCache=undefined;throw error;}
  }

  async function createQuote(request:{market:"BTC"|"ETH";side:"buy"|"sell";amount:string},persist=true){
    prune();if(persist&&quotes.size>=(options.maxActiveQuotes??50_000))throw new Error("firm quote capacity reached");let oracleQuote:Awaited<ReturnType<OracleSource["latest"]>>|undefined;
    if(options.oracleSource){oracleQuote=await options.oracleSource.latest(request.market);prices[request.market]=oracleQuote.snapshot;}
    else prices[request.market].observedAtMs=Date.now();
    let versions:ProtocolVersions,maxTradeNotional=DEFAULT_TRADE_LIMIT;
    if(clearing&&provider){
      if(options.chain?.devFund)await advanceLocalChainTime();
      let {blockNumber,values}=await readQuoteSnapshot();let [block,btc,eth,btcLimits,ethLimits,leaderEpoch,signerSetVersion,policyVersion,paused,resolutionRequired]=values;
      if(!block||paused||resolutionRequired)throw new Error("market is paused");
      const otherMarket=request.market==="BTC"?"ETH":"BTC",otherIndex=otherMarket==="BTC"?0:1,otherState=otherIndex===0?btc:eth;
      if(options.chain?.devFund&&sender&&BigInt(otherState.aggregateBase)!==0n&&block.timestamp-Number(otherState.lastPriceTime)>8){const snapshot=prices[otherMarket],report=AbiCoder.defaultAbiCoder().encode(["tuple(uint8 market,uint256 bid,uint256 ask,uint64 observedAt,uint64 validUntil)"],[[otherIndex,snapshot.bid,snapshot.ask,BigInt(block.timestamp),BigInt(block.timestamp+60)]]);await sender.submit(`local-oracle:${otherMarket}:${blockNumber}`,{to:options.chain.clearingAddress,data:clearing.interface.encodeFunctionData("refreshOracle",[report])});quoteSnapshotCache=undefined;({blockNumber,values}=await readQuoteSnapshot());[block,btc,eth,btcLimits,ethLimits,leaderEpoch,signerSetVersion,policyVersion,paused,resolutionRequired]=values;if(!block||paused||resolutionRequired)throw new Error("market is paused");}
      const marketNotional=(state:any,currentMark?:bigint)=>BigInt(state.aggregateBase)*(currentMark??(BigInt(state.lastBid)+BigInt(state.lastAsk))/2n)/BASE;
      const quoteMid=(prices[request.market].bid+prices[request.market].ask)/2n;
      settled.BTC=marketNotional(btc,request.market==="BTC"?quoteMid:undefined);settled.ETH=marketNotional(eth,request.market==="ETH"?quoteMid:undefined);
      versions={leaderEpoch:BigInt(leaderEpoch),signerSetVersion:BigInt(signerSetVersion),policyVersion:BigInt(policyVersion),blockNumber,blockTimestamp:block.timestamp};
      maxTradeNotional=decodeLimits(request.market==="BTC"?btcLimits:ethLimits).maxTradeNotional;
    }else versions=await readProtocolVersions();
    const operational=await hedgeRisk(),mode=operational?.markets[request.market].mode??"normal",delta=request.side==="buy"?parseUsdc(request.amount):-parseUsdc(request.amount),admission=hedgeAdmission(mode,settled[request.market],delta,maxTradeNotional);if(!admission.allowed)throw new Error("hedging unavailable: only exposure-reducing trades are allowed");
    const pricing:PricingParameters={maxNotional:admission.maxTradeNotional,baseSpreadBps:adaptiveSpreadBps(prices[request.market]),feeBps:2n,toleranceBps:8n};
    const quote=constructQuote(request,{...prices[request.market]},settled,pending,Date.now(),crypto.randomUUID(),pricing);
    if(oracleQuote){
      const localTimestamp=options.chain?.devFund?versions.blockTimestamp:undefined;
      const validUntil=localTimestamp===undefined?oracleQuote.validUntil:localTimestamp+60;
      const report=localTimestamp===undefined?oracleQuote.report:AbiCoder.defaultAbiCoder().encode(["tuple(uint8 market,uint256 bid,uint256 ask,uint64 observedAt,uint64 validUntil)"],[[request.market==="BTC"?0:1,quote.snapshot.bid,quote.snapshot.ask,localTimestamp,validUntil]]);
      quote.expiresAtMs=Math.min(quote.expiresAtMs,validUntil*1_000-4_000);if(quote.expiresAtMs<=Date.now())throw new Error("oracle report lacks inclusion time");if(persist)quoteReports.set(quote.quoteId,{report,validUntil});
    }
    if(persist){quotes.set(quote.quoteId,quote);quoteVersions.set(quote.quoteId,versions);}return {quote,versions};
  }

  async function publishStreams(){
    if(streamPublishing)return;streamPublishing=true;
    try{
      if(marketClients.size){try{const snapshot=await readMarkets(),payload=JSON.stringify(snapshot);if(payload!==lastMarketPayload){lastMarketPayload=payload;for(const client of marketClients)writeEvent(client,"markets",snapshot);}}catch(error){for(const client of marketClients)writeEvent(client,"stream-error",{error:error instanceof Error?error.message:"market data unavailable"});}}
    }finally{streamPublishing=false;if(streamPublishQueued){streamPublishQueued=false;scheduleStreamPublish();}}
  }

  app.get("/health",async()=>({ok:true,role:"leader",epoch:(clearing?await clearing.leaderEpoch():1n).toString(),chain:options.chain?{chainId:domain.chainId.toString(),clearingAddress:domain.verifyingContract}:null,marketData:options.oracleSource?.status?.()??{source:"configured"},streams:{connections:marketClients.size,eventsSent:streamSequence},firmQuotes:{active:quotes.size,capacity:options.maxActiveQuotes??50_000},orders:{active:activeOrderCount(),indexed:limitBook.size,capacity:options.maxRestingOrders??100_000},sender:sender?.status()}));
  app.get("/v1/config",async()=>({chainId:`0x${domain.chainId.toString(16)}`,chainName:options.chain?.devFund?"RFQ Local":"Base",rpcUrl:options.chain?.rpcUrl,clearingAddress:domain.verifyingContract,tokenAddress:options.chain?.tokenAddress}));
  if(localDevMode&&options.chain?.devWallet)app.get("/v1/dev/wallet",async()=>({mode:"local-development",...options.chain!.devWallet}));
  app.get("/v1/markets",async(_request,reply)=>{try{return await readMarkets();}catch(error){return reply.code(503).send({error:error instanceof Error?error.message:"market data unavailable"});}});
  app.get("/v1/markets/stream",async(request,reply)=>{
    reply.hijack();reply.raw.writeHead(200,{"content-type":"text/event-stream","cache-control":"no-cache, no-transform","connection":"keep-alive","access-control-allow-origin":options.corsOrigin??"http://127.0.0.1:4173"});
    const client=addStreamClient(reply.raw,marketClients);void readMarkets().then(snapshot=>writeEvent(client,"markets",snapshot)).catch(error=>writeEvent(client,"stream-error",{error:error instanceof Error?error.message:"market data unavailable"}));
  });
  app.get("/v1/account/:address",async(request,reply)=>{
    if(!clearing)return reply.code(503).send({error:"chain unavailable"});
    try {
      const account=getAddress((request.params as {address:string}).address),marketSnapshot=await readMarkets(),blockNumber=marketSnapshot.blockNumber;
      const [collateralRaw,btc,eth,onchainMaintenanceEquity,onchainOpeningEquity,onchainInitialMargin,onchainMaintenanceMargin]=await Promise.all([clearing.collateralOf(account,{blockTag:blockNumber}),clearing.positionOf(account,0,{blockTag:blockNumber}),clearing.positionOf(account,1,{blockTag:blockNumber}),clearing.maintenanceEquity(account,{blockTag:blockNumber}),clearing.openingEquity(account,{blockTag:blockNumber}),clearing.initialMargin(account,{blockTag:blockNumber}),clearing.maintenanceMargin(account,{blockTag:blockNumber})]);
      const collateral=BigInt(collateralRaw),positionsRaw=[btc,eth],names=["BTC","ETH"] as const;let unrealizedPnl=0n,accruedFunding=0n,grossNotional=0n,initialMargin=0n,maintenanceMargin=0n;
      const positions:Record<string,unknown>={};
      for(const [index,name] of names.entries()){
        const position=positionsRaw[index],size=BigInt(position.size),entryPrice=BigInt(position.entryPrice),market=marketSnapshot.markets[name],mark=size>=0n?BigInt(market.bid):BigInt(market.ask),notional=abs(size)*BigInt(market.ask)/BASE;
        const pnl=size>0n?abs(size)*(mark-entryPrice)/BASE:size<0n?abs(size)*(entryPrice-mark)/BASE:0n;
        const fundingPnl=-size*(BigInt(market.projectedFundingIndex)-BigInt(position.lastFundingIndex))/BASE;
        unrealizedPnl+=pnl;accruedFunding+=fundingPnl;grossNotional+=notional;initialMargin+=notional*marginRate(notional,true)/10_000n;maintenanceMargin+=notional*marginRate(notional,false)/10_000n;
        positions[name]={size:size.toString(),entryPrice:entryPrice.toString(),markPrice:mark.toString(),notional:notional.toString(),unrealizedPnl:pnl.toString(),accruedFunding:fundingPnl.toString(),lastFundingIndex:position.lastFundingIndex.toString()};
      }
      const equity=collateral+unrealizedPnl+accruedFunding,openingEquity=collateral+accruedFunding+(unrealizedPnl<0n?unrealizedPnl:0n),availableMargin=openingEquity-initialMargin,maintenanceBuffer=equity-maintenanceMargin;
      const healthAt=(selected:number,candidateMid:bigint)=>{let value=collateral+accruedFunding,required=0n;for(const [index,name] of names.entries()){const position=positionsRaw[index],size=BigInt(position.size);if(size===0n)continue;const current=marketSnapshot.markets[name],currentMid=BigInt(current.mid),bid=index===selected?candidateMid*BigInt(current.bid)/currentMid:BigInt(current.bid),ask=index===selected?candidateMid*BigInt(current.ask)/currentMid:BigInt(current.ask),entry=BigInt(position.entryPrice),quantity=abs(size);value+=size>0n?quantity*(bid-entry)/BASE:quantity*(entry-ask)/BASE;const notional=quantity*ask/BASE;required+=notional*marginRate(notional,false)/10_000n;}return value-required;};
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
    } catch(error){return reply.code(409).send({error:error instanceof Error&&error.message?error.message:"deposit route rejected"});}
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
    } catch(error){return reply.code(409).send({error:error instanceof Error?`deposit failed: ${error.message}`:"deposit failed"});}
  });
  app.post("/v1/withdraw/prepare",async(request,reply)=>{const parsed=withdrawalPrepareSchema.safeParse(request.body);if(!parsed.success)return reply.code(400).send({error:"invalid withdrawal request"});try{const account=getAddress(parsed.data.account),recipient=getAddress(parsed.data.recipient??parsed.data.account),amount=parseUnits(parsed.data.amount,6);if(amount<=0n)throw new Error();const intent:WithdrawalIntent={account,recipient,amount,nonce:BigInt(parsed.data.nonce),deadline:BigInt(await chainTimestamp()+120)};return {domain:{...domain,chainId:domain.chainId.toString()},types:withdrawalTypes,intent:withdrawalToWire(intent)};}catch{return reply.code(400).send({error:"invalid withdrawal request"});}});
  app.post("/v1/withdraw/execute",async(request,reply)=>{const parsed=withdrawalExecuteSchema.safeParse(request.body);if(!parsed.success)return reply.code(400).send({error:"invalid signed withdrawal"});try{const intent:WithdrawalIntent={account:getAddress(parsed.data.intent.account),recipient:getAddress(parsed.data.intent.recipient),amount:BigInt(parsed.data.intent.amount),nonce:BigInt(parsed.data.intent.nonce),deadline:BigInt(parsed.data.intent.deadline)};if(Number(intent.deadline)*1_000<=Date.now()||recoverWithdrawalSigner(domain,intent,parsed.data.userSignature)!==intent.account)return reply.code(401).send({error:"invalid withdrawal signature"});if(!clearing||!sender||!options.chain)return reply.code(503).send({error:"chain unavailable"});const receipt=await sender.submit(`withdraw:${intent.account}:${intent.nonce}`,{to:options.chain.clearingAddress,data:clearing.interface.encodeFunctionData("withdrawWithSignature",[intent.account,intent.recipient,intent.amount,intent.nonce,intent.deadline,parsed.data.userSignature])});return {status:"included",transaction:{hash:receipt.hash,blockNumber:receipt.blockNumber},collateral:(await clearing.collateralOf(intent.account)).toString()};}catch(error){return reply.code(409).send({error:error instanceof Error?`withdrawal failed: ${error.message}`:"withdrawal failed"});}});
  app.post("/v1/nonce/cancel/prepare",async(request,reply)=>{const parsed=actionBaseSchema.safeParse(request.body);if(!parsed.success)return reply.code(400).send({error:"invalid cancellation request"});try{const intent:CancelIntent={account:getAddress(parsed.data.account),nonce:BigInt(parsed.data.nonce),deadline:BigInt(await chainTimestamp()+120)};return {domain:{...domain,chainId:domain.chainId.toString()},types:cancelTypes,intent:cancelToWire(intent)};}catch{return reply.code(400).send({error:"invalid cancellation request"});}});
  app.post("/v1/nonce/cancel/execute",async(request,reply)=>{const parsed=cancelExecuteSchema.safeParse(request.body);if(!parsed.success)return reply.code(400).send({error:"invalid signed cancellation"});try{const intent:CancelIntent={account:getAddress(parsed.data.intent.account),nonce:BigInt(parsed.data.intent.nonce),deadline:BigInt(parsed.data.intent.deadline)};if(Number(intent.deadline)*1_000<=Date.now()||recoverCancelSigner(domain,intent,parsed.data.userSignature)!==intent.account)return reply.code(401).send({error:"invalid cancellation signature"});if(!clearing||!sender||!options.chain)return reply.code(503).send({error:"chain unavailable"});const receipt=await sender.submit(`cancel:${intent.account}:${intent.nonce}`,{to:options.chain.clearingAddress,data:clearing.interface.encodeFunctionData("cancelNonceWithSignature",[intent.account,intent.nonce,intent.deadline,parsed.data.userSignature])});return {status:"included",transaction:{hash:receipt.hash,blockNumber:receipt.blockNumber}};}catch(error){return reply.code(409).send({error:error instanceof Error?`cancellation failed: ${error.message}`:"cancellation failed"});}});
  app.post("/v1/close/prepare",async(request,reply)=>{const parsed=closePrepareSchema.safeParse(request.body);if(!parsed.success)return reply.code(400).send({error:"invalid close request"});try{const intent:CloseIntent={account:getAddress(parsed.data.account),market:parsed.data.market==="BTC"?0:1,nonce:BigInt(parsed.data.nonce),deadline:BigInt(await chainTimestamp()+120)};return {domain:{...domain,chainId:domain.chainId.toString()},types:closeTypes,intent:closeToWire(intent)};}catch{return reply.code(400).send({error:"invalid close request"});}});
  app.post("/v1/close/execute",async(request,reply)=>{const parsed=closeExecuteSchema.safeParse(request.body);if(!parsed.success)return reply.code(400).send({error:"invalid signed close"});try{const intent:CloseIntent={account:getAddress(parsed.data.intent.account),market:parsed.data.intent.market,nonce:BigInt(parsed.data.intent.nonce),deadline:BigInt(parsed.data.intent.deadline)};if(Number(intent.deadline)*1_000<=Date.now()||recoverCloseSigner(domain,intent,parsed.data.userSignature)!==intent.account)return reply.code(401).send({error:"invalid close signature"});if(!clearing||!sender||!provider||!options.chain)return reply.code(503).send({error:"chain unavailable"});const market=intent.market===0?"BTC":"ETH";let report:string;if(options.oracleSource){const observation=await options.oracleSource.latest(market);prices[market]=observation.snapshot;if(options.chain.devFund){const timestamp=await advanceLocalChainTime();report=AbiCoder.defaultAbiCoder().encode(["tuple(uint8 market,uint256 bid,uint256 ask,uint64 observedAt,uint64 validUntil)"],[[intent.market,observation.snapshot.bid,observation.snapshot.ask,BigInt(timestamp),BigInt(timestamp+60)]]);}else report=observation.report;}else{const timestamp=options.chain.devFund?await advanceLocalChainTime():Number(BigInt((await provider.send("eth_getBlockByNumber",["latest",false]) as {timestamp:string}).timestamp)),snapshot=prices[market];report=AbiCoder.defaultAbiCoder().encode(["tuple(uint8 market,uint256 bid,uint256 ask,uint64 observedAt,uint64 validUntil)"],[[intent.market,snapshot.bid,snapshot.ask,BigInt(timestamp),BigInt(timestamp+60)]]);}const receipt=await sender.submit(`close:${intent.account}:${intent.market}:${intent.nonce}`,{to:options.chain.clearingAddress,data:clearing.interface.encodeFunctionData("closePositionWithSignature",[intent.account,intent.market,intent.nonce,intent.deadline,report,parsed.data.userSignature])});const position=await clearing.positionOf(intent.account,intent.market);return {status:"included",transaction:{hash:receipt.hash,blockNumber:receipt.blockNumber},position:{size:position.size.toString(),entryPrice:position.entryPrice.toString()}};}catch(error){return reply.code(409).send({error:error instanceof Error?`close failed: ${error.message}`:"close failed"});}});
  app.post("/v1/session/prepare",async(request,reply)=>{const parsed=sessionPrepareSchema.safeParse(request.body);if(!parsed.success)return reply.code(400).send({error:"invalid session request"});try{const account=getAddress(parsed.data.account),session=getAddress(parsed.data.session),now=await chainTimestamp();const grant:SessionGrant={account,session,marketMask:parsed.data.marketMask,maxTradeNotional:parseUnits(parsed.data.maxTradeAmount,6),maxCumulativeNotional:parseUnits(parsed.data.maxCumulativeAmount,6),maxFee:parseUnits(parsed.data.maxFee,6),validUntil:BigInt(now+parsed.data.durationSeconds),nonce:BigInt(parsed.data.nonce),deadline:BigInt(now+120)};if(grant.maxTradeNotional<=0n||grant.maxTradeNotional>grant.maxCumulativeNotional)throw new Error();return {domain:{...domain,chainId:domain.chainId.toString()},types:sessionGrantTypes,grant:sessionGrantToWire(grant)};}catch{return reply.code(400).send({error:"invalid session request"});}});
  app.post("/v1/session/execute",async(request,reply)=>{const parsed=sessionExecuteSchema.safeParse(request.body);if(!parsed.success)return reply.code(400).send({error:"invalid signed session"});try{const grant:SessionGrant={...parsed.data.grant,account:getAddress(parsed.data.grant.account),session:getAddress(parsed.data.grant.session),maxTradeNotional:BigInt(parsed.data.grant.maxTradeNotional),maxCumulativeNotional:BigInt(parsed.data.grant.maxCumulativeNotional),maxFee:BigInt(parsed.data.grant.maxFee),validUntil:BigInt(parsed.data.grant.validUntil),nonce:BigInt(parsed.data.grant.nonce),deadline:BigInt(parsed.data.grant.deadline)};if(Number(grant.deadline)*1_000<=Date.now()||recoverSessionGrantSigner(domain,grant,parsed.data.userSignature)!==grant.account)return reply.code(401).send({error:"invalid session signature"});if(!clearing||!sender||!options.chain)return reply.code(503).send({error:"chain unavailable"});const receipt=await sender.submit(`session:${grant.account}:${grant.session}:${grant.nonce}`,{to:options.chain.clearingAddress,data:clearing.interface.encodeFunctionData("grantSessionWithSignature",[grant,parsed.data.userSignature])});return {status:"active",session:grant.session,validUntil:grant.validUntil.toString(),transaction:{hash:receipt.hash,blockNumber:receipt.blockNumber}};}catch(error){return reply.code(409).send({error:error instanceof Error?`session failed: ${error.message}`:"session failed"});}});
  app.post("/v1/orders/prepare",async(request,reply)=>{const parsed=orderPrepareSchema.safeParse(request.body);if(!parsed.success)return reply.code(400).send({error:"invalid limit order"});try{prune();if(activeOrderCount()>=(options.maxRestingOrders??100_000))throw new Error("order capacity reached");const account=getAddress(parsed.data.account),{quote,versions}=await createQuote({market:parsed.data.market,side:parsed.data.side,amount:parsed.data.amount},false),limitPrice=parseUnits(parsed.data.limitPrice,6),maximumNotional=abs(quote.baseDelta)*limitPrice/BASE,maxFee=(maximumNotional*2n+9_999n)/10_000n,deadline=BigInt(versions.blockTimestamp+parsed.data.durationSeconds),intent:TradeIntent={account,market:parsed.data.market==="BTC"?0:1,baseDelta:quote.baseDelta,limitPrice,maxFee,nonce:BigInt(parsed.data.nonce),deadline,reduceOnly:parsed.data.reduceOnly},orderId=crypto.randomUUID(),now=Date.now();if(limitPrice<=0n)throw new Error("invalid limit price");const order:RestingOrder={orderId,intent,market:parsed.data.market,side:parsed.data.side,amount:parsed.data.amount,status:"prepared",createdAtMs:now,updatedAtMs:now};restingOrders.set(orderId,order);return {orderId,domain:{...domain,chainId:domain.chainId.toString()},types:intentTypes,intent:intentToWire(intent),summary:{market:order.market,side:order.side,amount:order.amount,baseDelta:intent.baseDelta.toString(),limitPrice:intent.limitPrice.toString(),maxFee:intent.maxFee.toString(),expiresAtMs:Number(intent.deadline)*1_000}};}catch(error){return reply.code(409).send({error:error instanceof Error?error.message:"limit order rejected"});}});
  app.post("/v1/orders",async(request,reply)=>{const parsed=orderPlaceSchema.safeParse(request.body);if(!parsed.success)return reply.code(400).send({error:"invalid signed order"});const order=restingOrders.get(parsed.data.orderId);if(!order||order.status!=="prepared")return reply.code(404).send({error:"prepared order not found"});try{let valid=false;try{valid=recoverIntentSigner(domain,order.intent,parsed.data.userSignature)===order.intent.account;}catch{}if(!valid&&provider&&await provider.getCode(order.intent.account)!=="0x"){const wallet=new Contract(order.intent.account,["function isValidSignature(bytes32,bytes) view returns(bytes4)"],provider);valid=await wallet.isValidSignature(hashIntent(domain,order.intent),parsed.data.userSignature).then((value:string)=>value.toLowerCase()==="0x1626ba7e").catch(()=>false);}if(!valid)return reply.code(401).send({error:"invalid order signature"});order.userSignature=parsed.data.userSignature;order.status="open";order.updatedAtMs=Date.now();limitBook.add(order.orderId,order.market,order.side,order.intent.limitPrice,Number(order.intent.deadline)*1_000);journal?.prepare("INSERT INTO resting_orders VALUES(?,?,?,?,?,?,?,?,?,?,?,?)").run(order.orderId,order.intent.account,order.market,order.side,order.amount,JSON.stringify(intentToWire(order.intent)),order.userSignature,order.status,order.createdAtMs,order.updatedAtMs,null,null);scheduleOrderCheck();return {orderId:order.orderId,status:order.status,intent:intentToWire(order.intent)};}catch{return reply.code(401).send({error:"invalid order signature"});}});
  app.get("/v1/orders/:address",async(request,reply)=>{let account:string;try{account=getAddress((request.params as {address:string}).address);}catch{return reply.code(400).send({error:"invalid account"});}return {items:[...restingOrders.values()].filter(order=>order.intent.account===account&&order.status!=="prepared").sort((a,b)=>b.createdAtMs-a.createdAtMs).map(order=>({orderId:order.orderId,market:order.market,side:order.side,amount:order.amount,baseDelta:order.intent.baseDelta.toString(),limitPrice:order.intent.limitPrice.toString(),maxFee:order.intent.maxFee.toString(),nonce:order.intent.nonce.toString(),expiresAtMs:Number(order.intent.deadline)*1_000,status:order.status,transactionHash:order.transactionHash,lastError:order.lastError}))};});
  app.post("/v1/orders/:orderId/cancel/prepare",async(request,reply)=>{const order=restingOrders.get((request.params as {orderId:string}).orderId);if(!order||!order.userSignature)return reply.code(404).send({error:"order not found"});const intent:CancelIntent={account:order.intent.account,nonce:order.intent.nonce,deadline:BigInt(await chainTimestamp()+120)};return {domain:{...domain,chainId:domain.chainId.toString()},types:cancelTypes,intent:cancelToWire(intent)};});
  app.post("/v1/orders/:orderId/cancel",async(request,reply)=>{const order=restingOrders.get((request.params as {orderId:string}).orderId),parsed=cancelExecuteSchema.safeParse(request.body);if(!order||!parsed.success)return reply.code(400).send({error:"invalid order cancellation"});try{const intent:CancelIntent={account:getAddress(parsed.data.intent.account),nonce:BigInt(parsed.data.intent.nonce),deadline:BigInt(parsed.data.intent.deadline)};if(intent.account!==order.intent.account||intent.nonce!==order.intent.nonce||Number(intent.deadline)*1_000<=Date.now()||recoverCancelSigner(domain,intent,parsed.data.userSignature)!==intent.account)return reply.code(401).send({error:"invalid cancellation signature"});if(!clearing||!sender||!options.chain)return reply.code(503).send({error:"chain unavailable"});const receipt=await sender.submit(`cancel-order:${order.orderId}`,{to:options.chain.clearingAddress,data:clearing.interface.encodeFunctionData("cancelNonceWithSignature",[intent.account,intent.nonce,intent.deadline,parsed.data.userSignature])});order.status="cancelled";limitBook.remove(order.orderId);order.updatedAtMs=Date.now();order.transactionHash=receipt.hash;journal?.prepare("UPDATE resting_orders SET status='cancelled',tx_hash=?,updated_ms=? WHERE order_id=?").run(receipt.hash,order.updatedAtMs,order.orderId);return {orderId:order.orderId,status:order.status,transaction:{hash:receipt.hash,blockNumber:receipt.blockNumber}};}catch(error){return reply.code(409).send({error:error instanceof Error?error.message:"cancellation failed"});}});
  app.post("/v1/quote",async(request,reply)=>{
    const parsed=quoteRequestSchema.safeParse(request.body);
    if(!parsed.success)return reply.code(400).send({error:"invalid quote request"});
    try {return quoteToWire((await createQuote(parsed.data)).quote);} catch(error){return reply.code(options.oracleSource||options.hedgeRiskSource?503:409).send({error:error instanceof Error?error.message:"quote rejected"});}
  });
  app.post("/v1/prepare",async(request,reply)=>{
    const parsed=intentRequestSchema.safeParse(request.body);
    if(!parsed.success)return reply.code(400).send({error:"invalid intent request"});
    const quote=quotes.get(parsed.data.quoteId);
    const versions=quoteVersions.get(parsed.data.quoteId);
    if(!quote||!versions||quote.expiresAtMs<=Date.now())return reply.code(409).send({error:"quote expired"});
    try {
      const intent=makeIntent(quote,versions,parsed.data.account,parsed.data.nonce);
      const binding=quoteBindings.get(quote.quoteId);
      if(binding&&(binding.account!==intent.account||binding.nonce!==parsed.data.nonce))return reply.code(409).send({error:"quote already prepared"});
      quoteBindings.set(quote.quoteId,{account:intent.account,nonce:parsed.data.nonce});
      return {domain:{...domain,chainId:domain.chainId.toString()},types:intentTypes,intent:intentToWire(intent),intentHash:hashIntent(domain,intent)};
    } catch{return reply.code(400).send({error:"invalid account or nonce"});}
  });
  app.post("/v1/approve",async(request,reply)=>{
    const parsed=approvalRequestSchema.safeParse(request.body);
    if(!parsed.success)return reply.code(400).send({error:"invalid signed intent"});
    const quote=quotes.get(parsed.data.quoteId);
    const versions=quoteVersions.get(parsed.data.quoteId);
    if(!quote||!versions||quote.expiresAtMs<=Date.now())return reply.code(409).send({error:"quote expired"});
    const binding=quoteBindings.get(quote.quoteId);
    let requestedAccount:string;try{requestedAccount=getAddress(parsed.data.account);}catch{return reply.code(400).send({error:"invalid account"});}
    if(!binding||binding.account!==requestedAccount||binding.nonce!==parsed.data.nonce)return reply.code(409).send({error:"quote preparation mismatch"});
    let intent:TradeIntent;
    try { intent=makeIntent(quote,versions,parsed.data.account,parsed.data.nonce);let signer:string|undefined;try{signer=recoverIntentSigner(domain,intent,parsed.data.userSignature);}catch{}let accountAuthorized=signer===intent.account;if(!accountAuthorized&&provider&&await provider.getCode(intent.account)!=="0x"){const wallet=new Contract(intent.account,["function isValidSignature(bytes32,bytes) view returns(bytes4)"],provider);accountAuthorized=await wallet.isValidSignature(hashIntent(domain,intent),parsed.data.userSignature,{blockTag:versions.blockNumber}).then((value:string)=>value.toLowerCase()==="0x1626ba7e").catch(()=>false);}if(!accountAuthorized){if(!clearing||!signer)throw new Error();const session=await clearing.sessions(signer,{blockTag:versions.blockNumber});if(getAddress(session.account)!==intent.account||BigInt(session.validUntil)<intent.deadline||(Number(session.marketMask)&(1<<intent.market))===0||BigInt(session.maxFee)<intent.maxFee)throw new Error();} }
    catch{return reply.code(401).send({error:"invalid user signature"});}
    prune();const reportExpiry=quoteReports.get(quote.quoteId)?.validUntil??versions.blockTimestamp+30,approvalDeadline=BigInt(Math.min(Number(intent.deadline),versions.blockTimestamp+30,reportExpiry));
    if(!pending.some(item=>item.quoteId===quote.quoteId)){pending.push({quoteId:quote.quoteId,market:quote.market,delta:quote.delta,expiresAtMs:Number(approvalDeadline)*1_000});marketReadCache=undefined;scheduleStreamPublish();}
    const intentHash=hashIntent(domain,intent);
    let report=quoteReports.get(quote.quoteId)?.report??"0x";
    if(provider&&report==="0x"){
      const timestamp=options.chain?.devFund?await advanceLocalChainTime():Number(BigInt((await provider.send("eth_getBlockByNumber",["latest",false]) as {timestamp:string}).timestamp));
      report=AbiCoder.defaultAbiCoder().encode(["tuple(uint8 market,uint256 bid,uint256 ask,uint64 observedAt,uint64 validUntil)"],[[intent.market,quote.snapshot.bid,quote.snapshot.ask,BigInt(timestamp),BigInt(timestamp+60)]]);
    }
    const oracleReportHash=report==="0x"?keccak256(toUtf8Bytes(JSON.stringify({market:quote.market,bid:quote.snapshot.bid.toString(),ask:quote.snapshot.ask.toString(),observedAtMs:quote.snapshot.observedAtMs}))):keccak256(report);
    const approval:MakerApproval={intentHash,executionPrice:quote.expectedPrice,impactCharge:quote.impactCharge,fee:quote.fee,oracleReportHash,deadline:approvalDeadline,leaderEpoch:versions.leaderEpoch,signerSetVersion:versions.signerSetVersion,policyVersion:versions.policyVersion};
    const digest=hashApproval(domain,approval);
    journal?.prepare("INSERT INTO commitments VALUES (?, ?, ?, ?, 'reserved', ?, ?, ?, NULL, ?) ON CONFLICT(quote_id) DO UPDATE SET status='reserved', intent_json=excluded.intent_json, user_signature=excluded.user_signature, approval_json=excluded.approval_json, updated_ms=excluded.updated_ms").run(quote.quoteId,quote.market,quote.delta.toString(),Number(approvalDeadline)*1_000,JSON.stringify(intentToWire(intent)),parsed.data.userSignature,JSON.stringify(approvalToWire(approval)),Date.now());
    const approverPayload={domain:{...domain,chainId:domain.chainId.toString()},intent:intentToWire(intent),userSignature:parsed.data.userSignature,approval:approvalToWire(approval),quote:quoteToWire(quote),report,oracleAgeMs:Date.now()-quote.snapshot.observedAtMs};
    const responses=await Promise.allSettled((options.approvers??[]).map(async approver=>{
      const response=await fetchImpl(`${approver.url}/approve`,{method:"POST",headers:{"content-type":"application/json",authorization:`Bearer ${approver.token}`},body:JSON.stringify(approverPayload),signal:AbortSignal.timeout(1_000)});
      if(!response.ok)throw new Error(`approver ${response.status}: ${await response.text()}`);
      const result=await response.json() as {digest:string;signer:string;signature:string};
      if(result.digest!==digest||recoverAddress(digest,result.signature).toLowerCase()!==result.signer.toLowerCase())throw new Error("invalid approver response");
      return result;
    }));
    const approvals=responses.filter((item):item is PromiseFulfilledResult<{digest:string;signer:string;signature:string}>=>item.status==="fulfilled").map(item=>item.value);
    const distinct=new Map(approvals.map(item=>[item.signer.toLowerCase(),item]));
    if(distinct.size<2)return reply.code(503).send({error:"approver quorum unavailable",details:options.chain?.devFund?responses.filter(item=>item.status==="rejected").map(item=>String(item.reason)):undefined});
    const selected=[...distinct.values()].slice(0,2);
    journal?.prepare("UPDATE commitments SET status='approved', updated_ms=? WHERE quote_id=?").run(Date.now(),quote.quoteId);
    let transaction:undefined|{hash:string;blockNumber:number;collateral:string;position:{size:string;entryPrice:string;lastFundingIndex:string}};
    if(clearing&&token&&provider&&options.chain&&sender){
      try {
        if(options.chain.devFund&&BigInt(await clearing.collateralOf(intent.account))<2_000n*1_000_000n){
          const amount=10_000n*1_000_000n,depositNonce=keccak256(toUtf8Bytes(`autofund:${quote.quoteId}`)),timestamp=await advanceLocalChainTime();
          await sender.submit(`autofund-mint:${quote.quoteId}`,{to:options.chain.tokenAddress,data:token.interface.encodeFunctionData("mint",[intent.account,amount])});
          await sender.submit(`autofund:${quote.quoteId}`,{to:options.chain.clearingAddress,data:clearing.interface.encodeFunctionData("depositWithAuthorization",[intent.account,amount,timestamp-60,timestamp+600,depositNonce,27,"0x"+"00".repeat(32),"0x"+"00".repeat(32)])});
        }
        const receipt=await sender.submit(`trade:${quote.quoteId}`,{to:options.chain.clearingAddress,data:clearing.interface.encodeFunctionData("executeTrade",[intent,approval,report,parsed.data.userSignature,selected[0].signature,selected[1].signature])});quoteSnapshotCache=undefined;marketReadCache=undefined;journal?.prepare("UPDATE commitments SET status='submitted', tx_hash=?, updated_ms=? WHERE quote_id=?").run(receipt.hash,Date.now(),quote.quoteId);
        const collateral=await clearing.collateralOf(intent.account); const position=await clearing.positionOf(intent.account,intent.market);
        transaction={hash:receipt.hash,blockNumber:receipt.blockNumber,collateral:collateral.toString(),position:{size:position.size.toString(),entryPrice:position.entryPrice.toString(),lastFundingIndex:position.lastFundingIndex.toString()}};
        journal?.prepare("UPDATE commitments SET status='included', updated_ms=? WHERE quote_id=?").run(Date.now(),quote.quoteId);
        settled[quote.market]+=quote.delta; const index=pending.findIndex(item=>item.quoteId===quote.quoteId); if(index>=0)pending.splice(index,1);marketReadCache=undefined;scheduleStreamPublish();
      } catch(error){return reply.code(409).send({error:error instanceof Error?`chain submission failed: ${error.message}`:"chain submission failed"});}
    }
    return {domain:{...domain,chainId:domain.chainId.toString()},intent:intentToWire(intent),userSignature:parsed.data.userSignature,approval:approvalToWire(approval),approvals:selected,quote:quoteToWire(quote),transaction};
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
      }catch(error){order.status="open";limitBook.add(order.orderId,order.market,order.side,order.intent.limitPrice,Number(order.intent.deadline)*1_000);order.updatedAtMs=Date.now();order.lastError=error instanceof Error?error.message:"execution unavailable";journal?.prepare("UPDATE resting_orders SET status='open',updated_ms=?,last_error=? WHERE order_id=?").run(order.updatedAtMs,order.lastError,order.orderId);}
    }}finally{checkingOrders=false;if(orderCheckQueued){orderCheckQueued=false;scheduleOrderCheck();}}
  }
  app.addHook("onReady",async()=>{await sender?.reconcile();unsubscribeOracle=options.oracleSource?.subscribe?.(()=>{scheduleStreamPublish();scheduleOrderCheck();});await options.oracleSource?.start?.();orderReconcileTimer=setInterval(()=>scheduleOrderCheck(),30_000);orderReconcileTimer.unref();heartbeatTimer=setInterval(()=>{for(const client of marketClients)client.response.write(": heartbeat\n\n");},15_000);heartbeatTimer.unref();});
  app.addHook("onClose",async()=>{if(orderTimer)clearTimeout(orderTimer);if(orderReconcileTimer)clearInterval(orderReconcileTimer);if(streamTimer)clearTimeout(streamTimer);if(heartbeatTimer)clearInterval(heartbeatTimer);unsubscribeOracle?.();for(const client of marketClients)client.response.end();await options.oracleSource?.close?.();journal?.close();});
  return app;
}
