import Fastify from "fastify";
import cors from "@fastify/cors";
import { DatabaseSync } from "node:sqlite";
import { keccak256, toUtf8Bytes } from "ethers";

type Market="BTC"|"ETH";
type ExposureResponse={blockNumber:number;markets:Record<Market,{aggregateBase:string;bid:string;ask:string}>};
export interface HedgeOptions{indexerUrl:string;databasePath:string;fetchImpl?:typeof fetch;pollMs?:number;bandUsdc?:bigint;maxOrderUsdc?:bigint}

export function buildHedger(options:HedgeOptions){
  const app=Fastify({logger:false});app.register(cors,{origin:"http://127.0.0.1:4174"});const db=new DatabaseSync(options.databasePath);const fetchImpl=options.fetchImpl??fetch;
  db.exec("PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS hedge_orders(client_id TEXT PRIMARY KEY,market TEXT NOT NULL,target_block INTEGER NOT NULL,base_delta TEXT NOT NULL,limit_price TEXT NOT NULL,status TEXT NOT NULL,venue_order_id TEXT,created_ms INTEGER NOT NULL,updated_ms INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS venue_positions(market TEXT PRIMARY KEY,base_size TEXT NOT NULL); INSERT OR IGNORE INTO venue_positions VALUES('BTC','0'),('ETH','0')");
  let ticking:Promise<void>|undefined;let timer:ReturnType<typeof setInterval>|undefined;let lastError:string|undefined;let lastIndexedBlock=-1;let lastExposure:ExposureResponse|undefined;
  const position=(market:Market)=>BigInt((db.prepare("SELECT base_size FROM venue_positions WHERE market=?").get(market) as {base_size:string}).base_size);
  function venueOrder(clientId:string,market:Market,delta:bigint){
    const existing=db.prepare("SELECT venue_order_id,status FROM hedge_orders WHERE client_id=?").get(clientId) as {venue_order_id:string|null;status:string}|undefined;
    if(existing?.status==="filled")return existing.venue_order_id!;
    const venueId=`local-${clientId.slice(2,14)}`;db.exec("BEGIN IMMEDIATE");
    try{db.prepare("UPDATE venue_positions SET base_size=? WHERE market=?").run((position(market)+delta).toString(),market);db.prepare("UPDATE hedge_orders SET status='filled',venue_order_id=?,updated_ms=? WHERE client_id=?").run(venueId,Date.now(),clientId);db.exec("COMMIT");return venueId;}catch(error){db.exec("ROLLBACK");throw error;}
  }
  async function doTick(){
    const response=await fetchImpl(`${options.indexerUrl}/v1/exposure?finalized=true`,{signal:AbortSignal.timeout(1_000)});if(!response.ok)throw new Error(`indexer ${response.status}`);const exposure=await response.json() as ExposureResponse;lastExposure=exposure;lastIndexedBlock=exposure.blockNumber;
    for(const market of ["BTC","ETH"] as Market[]){const state=exposure.markets[market],bid=BigInt(state.bid),ask=BigInt(state.ask);if(bid===0n||ask===0n)continue;const mid=(bid+ask)/2n,target=BigInt(state.aggregateBase),current=position(market),gap=target-current;const notional=(gap<0n?-gap:gap)*mid/10n**18n;const band=options.bandUsdc??25_000n*1_000_000n;if(notional<=band)continue;const residualBase=(band/2n)*10n**18n/mid;let delta=gap-(gap>0n?residualBase:-residualBase);const maxBase=(options.maxOrderUsdc??25_000n*1_000_000n)*10n**18n/mid;if(delta>maxBase)delta=maxBase;if(delta< -maxBase)delta=-maxBase;const limit=gap>0n?ask*10_020n/10_000n:bid*9_980n/10_000n;const clientId=keccak256(toUtf8Bytes(`rfq:${exposure.blockNumber}:${market}:${target}`));
      const exists=db.prepare("SELECT status FROM hedge_orders WHERE client_id=?").get(clientId) as {status:string}|undefined;if(exists?.status==="filled")continue;
      db.prepare("INSERT OR IGNORE INTO hedge_orders VALUES(?,?,?,?,?,'planned',NULL,?,?)").run(clientId,market,exposure.blockNumber,delta.toString(),limit.toString(),Date.now(),Date.now());venueOrder(clientId,market,delta);
    }
  }
  async function tick(){if(ticking)return ticking;ticking=doTick().then(()=>{lastError=undefined}).catch(error=>{lastError=String(error)}).finally(()=>{ticking=undefined});return ticking;}
  app.get("/health",async()=>({ok:!lastError,indexedBlock:lastIndexedBlock,error:lastError}));
  app.get("/v1/status",async()=>{const band=options.bandUsdc??25_000n*1_000_000n;const positions={BTC:position("BTC").toString(),ETH:position("ETH").toString()};const markets=Object.fromEntries((["BTC","ETH"] as Market[]).map(market=>{const source=lastExposure?.markets[market],target=BigInt(source?.aggregateBase??0),venue=BigInt(positions[market]),gap=target-venue,mid=source?(BigInt(source.bid)+BigInt(source.ask))/2n:0n,gapNotional=(gap<0n?-gap:gap)*mid/10n**18n;return [market,{customerBase:target.toString(),venueBase:venue.toString(),gapBase:gap.toString(),gapNotional:gapNotional.toString(),bandUsdc:band.toString(),state:gapNotional<=band?"within_band":"hedge_required"}];}));return {mode:"local-simulator",indexedBlock:lastIndexedBlock,healthy:!lastError,error:lastError,positions,markets,orders:db.prepare("SELECT * FROM hedge_orders ORDER BY created_ms DESC LIMIT 20").all()};});
  app.post("/v1/tick",async()=>{await tick();return {ok:!lastError,error:lastError,positions:{BTC:position("BTC").toString(),ETH:position("ETH").toString()}};});
  app.addHook("onReady",async()=>{await tick();timer=setInterval(()=>void tick(),options.pollMs??1_000);timer.unref();});app.addHook("onClose",async()=>{if(timer)clearInterval(timer);await ticking;db.close();});return app;
}
