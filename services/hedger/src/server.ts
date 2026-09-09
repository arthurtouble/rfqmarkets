import Fastify from "fastify";
import cors from "@fastify/cors";
import { DatabaseSync } from "node:sqlite";
import { keccak256, toUtf8Bytes } from "ethers";
import type { HedgeRiskSnapshot } from "../../../packages/shared/src/hedge-risk.js";

export type HedgeMarket="BTC"|"ETH";
type ExposureResponse={blockNumber:number;markets:Record<HedgeMarket,{aggregateBase:string;bid:string;ask:string}>};
export interface VenueOrder {clientId:string;market:HedgeMarket;baseDelta:bigint;limitPrice:bigint}
export interface VenueResult {venueOrderId:string;status:"open"|"partial"|"filled"|"rejected";filledBase:bigint}
export interface HedgeVenue {readonly mode:string;position(market:HedgeMarket):Promise<bigint>;find(clientId:string):Promise<VenueResult|null>;submit(order:VenueOrder):Promise<VenueResult>}
export interface HedgeOptions{indexerUrl:string;databasePath:string;fetchImpl?:typeof fetch;pollMs?:number;bandUsdc?:bigint;maxOrderUsdc?:bigint;venue?:HedgeVenue;healthToken?:string}

export class LocalHedgeVenue implements HedgeVenue{
  readonly mode="local-simulator";
  constructor(private db:DatabaseSync){db.exec("CREATE TABLE IF NOT EXISTS local_venue_positions(market TEXT PRIMARY KEY,base_size TEXT NOT NULL); INSERT OR IGNORE INTO local_venue_positions VALUES('BTC','0'),('ETH','0'); CREATE TABLE IF NOT EXISTS local_venue_orders(client_id TEXT PRIMARY KEY,venue_order_id TEXT NOT NULL,market TEXT NOT NULL,base_delta TEXT NOT NULL,status TEXT NOT NULL)");}
  async position(market:HedgeMarket){return BigInt((this.db.prepare("SELECT base_size FROM local_venue_positions WHERE market=?").get(market) as {base_size:string}).base_size);}
  async find(clientId:string){const row=this.db.prepare("SELECT venue_order_id,base_delta,status FROM local_venue_orders WHERE client_id=?").get(clientId) as {venue_order_id:string;base_delta:string;status:VenueResult["status"]}|undefined;return row?{venueOrderId:row.venue_order_id,status:row.status,filledBase:BigInt(row.base_delta)}:null;}
  async submit(order:VenueOrder){const found=await this.find(order.clientId);if(found)return found;const venueOrderId=`local-${order.clientId.slice(2,14)}`;this.db.exec("BEGIN IMMEDIATE");try{const current=await this.position(order.market);this.db.prepare("INSERT INTO local_venue_orders VALUES(?,?,?,?, 'filled')").run(order.clientId,venueOrderId,order.market,order.baseDelta.toString());this.db.prepare("UPDATE local_venue_positions SET base_size=? WHERE market=?").run((current+order.baseDelta).toString(),order.market);this.db.exec("COMMIT");return {venueOrderId,status:"filled",filledBase:order.baseDelta} as VenueResult;}catch(error){this.db.exec("ROLLBACK");throw error;}}
}

export function buildHedger(options:HedgeOptions){
  const app=Fastify({logger:false});app.register(cors,{origin:"http://127.0.0.1:4174"});const db=new DatabaseSync(options.databasePath);const fetchImpl=options.fetchImpl??fetch;
  db.exec("PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS hedge_orders(client_id TEXT PRIMARY KEY,market TEXT NOT NULL,target_block INTEGER NOT NULL,base_delta TEXT NOT NULL,limit_price TEXT NOT NULL,status TEXT NOT NULL,venue_order_id TEXT,filled_base TEXT NOT NULL DEFAULT '0',created_ms INTEGER NOT NULL,updated_ms INTEGER NOT NULL)");
  const columns=db.prepare("PRAGMA table_info(hedge_orders)").all() as Array<{name:string}>;if(!columns.some(column=>column.name==="filled_base"))db.exec("ALTER TABLE hedge_orders ADD COLUMN filled_base TEXT NOT NULL DEFAULT '0'");
  const venue=options.venue??new LocalHedgeVenue(db);let ticking:Promise<void>|undefined,timer:ReturnType<typeof setInterval>|undefined,lastError:string|undefined,lastIndexedBlock=-1,lastExposure:ExposureResponse|undefined,lastSuccessAtMs=0;
  const record=(clientId:string,result:VenueResult)=>db.prepare("UPDATE hedge_orders SET status=?,venue_order_id=?,filled_base=?,updated_ms=? WHERE client_id=?").run(result.status,result.venueOrderId,result.filledBase.toString(),Date.now(),clientId);
  async function reconcileOrSubmit(order:VenueOrder){const found=await venue.find(order.clientId);if(found){record(order.clientId,found);return;}db.prepare("UPDATE hedge_orders SET status='submitted',updated_ms=? WHERE client_id=?").run(Date.now(),order.clientId);record(order.clientId,await venue.submit(order));}
  async function doTick(){
    const outstanding=db.prepare("SELECT client_id,market,base_delta,limit_price FROM hedge_orders WHERE status IN ('planned','submitted','open') ORDER BY created_ms").all() as Array<{client_id:string;market:HedgeMarket;base_delta:string;limit_price:string}>;
    for(const order of outstanding)await reconcileOrSubmit({clientId:order.client_id,market:order.market,baseDelta:BigInt(order.base_delta),limitPrice:BigInt(order.limit_price)});
    // An open venue order already reserves risk. Do not stack another order on the
    // same exposure until the venue reports a terminal fill or rejection.
    const blockedMarkets=new Set((db.prepare("SELECT DISTINCT market FROM hedge_orders WHERE status IN ('planned','submitted','open')").all() as Array<{market:HedgeMarket}>).map(row=>row.market));
    const response=await fetchImpl(`${options.indexerUrl}/v1/exposure?finalized=true`,{signal:AbortSignal.timeout(1_000)});if(!response.ok)throw new Error(`indexer ${response.status}`);const exposure=await response.json() as ExposureResponse;lastExposure=exposure;lastIndexedBlock=exposure.blockNumber;
    for(const market of ["BTC","ETH"] as HedgeMarket[]){if(blockedMarkets.has(market))continue;const state=exposure.markets[market],bid=BigInt(state.bid),ask=BigInt(state.ask);if(bid===0n||ask===0n)continue;const mid=(bid+ask)/2n,target=BigInt(state.aggregateBase),current=await venue.position(market),gap=target-current,notional=(gap<0n?-gap:gap)*mid/10n**18n,band=options.bandUsdc??25_000n*1_000_000n;if(notional<=band)continue;const residualBase=(band/2n)*10n**18n/mid;let delta=gap-(gap>0n?residualBase:-residualBase);const maxBase=(options.maxOrderUsdc??25_000n*1_000_000n)*10n**18n/mid;if(delta>maxBase)delta=maxBase;if(delta< -maxBase)delta=-maxBase;const limit=gap>0n?ask*10_020n/10_000n:bid*9_980n/10_000n,clientId=keccak256(toUtf8Bytes(`rfq:${exposure.blockNumber}:${market}:${target}:${current}`));
      const exists=db.prepare("SELECT status FROM hedge_orders WHERE client_id=?").get(clientId) as {status:string}|undefined;if(exists){if(exists.status==="planned"||exists.status==="submitted")await reconcileOrSubmit({clientId,market,baseDelta:delta,limitPrice:limit});continue;}
      db.prepare("INSERT INTO hedge_orders(client_id,market,target_block,base_delta,limit_price,status,venue_order_id,filled_base,created_ms,updated_ms) VALUES(?,?,?,?,?,'planned',NULL,'0',?,?)").run(clientId,market,exposure.blockNumber,delta.toString(),limit.toString(),Date.now(),Date.now());await reconcileOrSubmit({clientId,market,baseDelta:delta,limitPrice:limit});
    }
  }
  async function tick(){if(ticking)return ticking;ticking=doTick().then(()=>{lastError=undefined;lastSuccessAtMs=Date.now()}).catch(error=>{lastError=String(error)}).finally(()=>{ticking=undefined});return ticking;}
  async function riskSnapshot():Promise<HedgeRiskSnapshot>{const band=options.bandUsdc??25_000n*1_000_000n,stale=Date.now()-lastSuccessAtMs>3_000,healthy=!lastError&&!stale,markets={} as HedgeRiskSnapshot["markets"];for(const market of ["BTC","ETH"] as HedgeMarket[]){const source=lastExposure?.markets[market],target=BigInt(source?.aggregateBase??0),current=await venue.position(market),mid=source?(BigInt(source.bid)+BigInt(source.ask))/2n:0n,gap=target-current,gapNotional=(gap<0n?-gap:gap)*mid/10n**18n,mode=!healthy||gapNotional>band*2n?"reduce_only":gapNotional>band?"guarded":"normal";markets[market]={mode,gapNotional:gapNotional.toString(),bandUsdc:band.toString()};}return {observedAtMs:lastSuccessAtMs,healthy,indexedBlock:lastIndexedBlock,markets};}
  app.get("/health",async()=>({ok:!lastError,indexedBlock:lastIndexedBlock,error:lastError}));
  app.get("/internal/risk",async(request,reply)=>{if(!options.healthToken||request.headers.authorization!==`Bearer ${options.healthToken}`)return reply.code(401).send({error:"unauthorized"});return riskSnapshot();});
  app.get("/v1/status",async()=>{const band=options.bandUsdc??25_000n*1_000_000n,positions={BTC:(await venue.position("BTC")).toString(),ETH:(await venue.position("ETH")).toString()},markets=Object.fromEntries((["BTC","ETH"] as HedgeMarket[]).map(market=>{const source=lastExposure?.markets[market],target=BigInt(source?.aggregateBase??0),current=BigInt(positions[market]),gap=target-current,mid=source?(BigInt(source.bid)+BigInt(source.ask))/2n:0n,gapNotional=(gap<0n?-gap:gap)*mid/10n**18n;return [market,{customerBase:target.toString(),venueBase:current.toString(),gapBase:gap.toString(),gapNotional:gapNotional.toString(),bandUsdc:band.toString(),state:gapNotional<=band?"within_band":"hedge_required"}];}));return {mode:venue.mode,indexedBlock:lastIndexedBlock,healthy:!lastError,error:lastError,positions,markets,orders:db.prepare("SELECT * FROM hedge_orders ORDER BY created_ms DESC LIMIT 20").all()};});
  app.post("/v1/tick",async()=>{await tick();return {ok:!lastError,error:lastError,positions:{BTC:(await venue.position("BTC")).toString(),ETH:(await venue.position("ETH")).toString()}};});
  app.addHook("onReady",async()=>{await tick();timer=setInterval(()=>void tick(),options.pollMs??1_000);timer.unref();});app.addHook("onClose",async()=>{if(timer)clearInterval(timer);await ticking;db.close();});return app;
}
