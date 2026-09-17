import Fastify from "fastify";
import cors from "@fastify/cors";
import type { ServerResponse } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { Contract, Interface, JsonRpcProvider, getAddress, type Log } from "ethers";
import { clearingIndexerAbi } from "../../../packages/shared/src/abi.js";
import { RiskProjection, type AccountProjection } from "./risk-projection.js";
import {tradeDetails,type IndexedPosition} from "./trade-activity.js";

export interface IndexerOptions{rpcUrl:string;clearingAddress:string;databasePath:string;startBlock?:number;confirmations?:number;pollMs?:number;corsOrigin?:string|string[];provider?:JsonRpcProvider}

export function buildIndexer(options:IndexerOptions){
  const corsOrigins=options.corsOrigin??["http://127.0.0.1:4173","http://127.0.0.1:4174"],originFor=(requestOrigin:string|undefined)=>{const allowed=Array.isArray(corsOrigins)?corsOrigins:[corsOrigins];return requestOrigin&&allowed.includes(requestOrigin)?requestOrigin:allowed[0];};
  // The first finalized sync can span the full deployment history and depends
  // on public RPC latency. Keep Fastify's startup watchdog above the ordinary
  // ten-second plugin default while retaining a finite failure boundary.
  const app=Fastify({logger:false,pluginTimeout:60_000});app.register(cors,{origin:corsOrigins});
  const provider=options.provider??new JsonRpcProvider(options.rpcUrl,undefined,{batchMaxCount:1});const contract=new Contract(options.clearingAddress,clearingIndexerAbi,provider);const iface=new Interface(clearingIndexerAbi);const db=new DatabaseSync(options.databasePath);
  db.exec("PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS blocks(number INTEGER PRIMARY KEY,hash TEXT NOT NULL,parent_hash TEXT NOT NULL,timestamp INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS activity(tx_hash TEXT NOT NULL,log_index INTEGER NOT NULL,block_number INTEGER NOT NULL,block_hash TEXT NOT NULL,timestamp INTEGER NOT NULL,kind TEXT NOT NULL,account TEXT,market INTEGER,payload TEXT NOT NULL,PRIMARY KEY(tx_hash,log_index)); CREATE INDEX IF NOT EXISTS activity_account_block ON activity(account,block_number DESC,log_index DESC); CREATE TABLE IF NOT EXISTS accounts(account TEXT PRIMARY KEY,collateral TEXT NOT NULL,btc_size TEXT NOT NULL,btc_entry TEXT NOT NULL,eth_size TEXT NOT NULL,eth_entry TEXT NOT NULL,indexed_block INTEGER NOT NULL,indexed_tx TEXT); CREATE TABLE IF NOT EXISTS finalized_accounts(account TEXT PRIMARY KEY,collateral TEXT NOT NULL,btc_size TEXT NOT NULL,btc_entry TEXT NOT NULL,eth_size TEXT NOT NULL,eth_entry TEXT NOT NULL,indexed_block INTEGER NOT NULL,indexed_tx TEXT); CREATE INDEX IF NOT EXISTS accounts_open ON accounts(account) WHERE btc_size != '0' OR eth_size != '0'; CREATE INDEX IF NOT EXISTS finalized_accounts_open ON finalized_accounts(account) WHERE btc_size != '0' OR eth_size != '0'; CREATE TABLE IF NOT EXISTS metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL)");
  const liveRisk=new RiskProjection(),finalizedRisk=new RiskProjection();
  for(const row of db.prepare("SELECT account,collateral,btc_size,eth_size FROM accounts").all() as AccountProjection[])liveRisk.update(row);
  for(const row of db.prepare("SELECT account,collateral,btc_size,eth_size FROM finalized_accounts").all() as AccountProjection[])finalizedRisk.update(row);
  let syncing:Promise<{accounts:Set<string>;reset:boolean}>|undefined;let timer:ReturnType<typeof setInterval>|undefined;let heartbeat:ReturnType<typeof setInterval>|undefined;let lastError:string|undefined,lastPublishedBlock=-1;const updateClients=new Set<ServerResponse>();
  function indexedBlock(){return (db.prepare("SELECT max(number) value FROM blocks").get() as {value:number|null}).value??((options.startBlock??0)-1);}
  function publishUpdate(accounts:Set<string>,reset=false){const block=indexedBlock();if(block===lastPublishedBlock&&!accounts.size&&!reset)return;lastPublishedBlock=block;const data=`event: indexed\ndata: ${JSON.stringify({indexedBlock:block,changed:accounts.size>0||reset,reset,accounts:[...accounts]})}\n\n`;for(const client of updateClients){if(client.destroyed||client.writableEnded){updateClients.delete(client);continue;}if(client.writableLength>262_144){client.destroy();updateClients.delete(client);continue;}client.write(data);}}
  function atomic(write:()=>void){db.exec("BEGIN IMMEDIATE");try{write();db.exec("COMMIT");}catch(error){db.exec("ROLLBACK");throw error;}}
  const projectionVersion="2",reset=()=>{atomic(()=>{db.exec("DELETE FROM blocks; DELETE FROM activity; DELETE FROM accounts; DELETE FROM finalized_accounts; DELETE FROM metadata");db.prepare("INSERT INTO metadata VALUES('activity_projection_version',?)").run(projectionVersion);});liveRisk.clear();finalizedRisk.clear();};
  if((db.prepare("SELECT value FROM metadata WHERE key='activity_projection_version'").get() as {value:string}|undefined)?.value!==projectionVersion)reset();
  async function readAccount(account:string,blockTag:number,txHash?:string){
    const [collateral,btc,eth]=await Promise.all([contract.collateralOf(account,{blockTag}),contract.positionOf(account,0,{blockTag}),contract.positionOf(account,1,{blockTag})]);
    return {account,collateral:collateral.toString(),btc_size:btc.size.toString(),btc_entry:btc.entryPrice.toString(),eth_size:eth.size.toString(),eth_entry:eth.entryPrice.toString(),blockTag,txHash};
  }
  type AccountRow=Awaited<ReturnType<typeof readAccount>>;
  function writeAccount(row:AccountRow,table:"accounts"|"finalized_accounts"){
    db.prepare(`INSERT INTO ${table} VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(account) DO UPDATE SET collateral=excluded.collateral,btc_size=excluded.btc_size,btc_entry=excluded.btc_entry,eth_size=excluded.eth_size,eth_entry=excluded.eth_entry,indexed_block=excluded.indexed_block,indexed_tx=excluded.indexed_tx`).run(row.account,row.collateral,row.btc_size,row.btc_entry,row.eth_size,row.eth_entry,row.blockTag,row.txHash??null);
  }
  async function stageFinalized(head:number,tip=indexedBlock(),newAccounts:Array<{account:string;block:number}>=[]){
    const target=Math.min(tip,Math.max((options.startBlock??0)-1,head-(options.confirmations??2))),stored=Number((db.prepare("SELECT value FROM metadata WHERE key='finalized_cursor'").get() as {value:string}|undefined)?.value??((options.startBlock??0)-1));
    if(target<=stored)return undefined;
    const affected=new Set((db.prepare("SELECT DISTINCT account FROM activity WHERE account IS NOT NULL AND block_number>? AND block_number<=?").all(stored,target) as Array<{account:string}>).map(row=>row.account));
    for(const row of newAccounts)if(row.block>stored&&row.block<=target)affected.add(row.account);
    const rows=await Promise.all([...affected].map(account=>readAccount(account,target)));
    return {target,rows};
  }
  function writeFinalized(stage:Awaited<ReturnType<typeof stageFinalized>>){if(!stage)return;for(const row of stage.rows)writeAccount(row,"finalized_accounts");db.prepare("INSERT INTO metadata VALUES('finalized_cursor',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(String(stage.target));}
  async function syncPass(){
    const head=await provider.getBlockNumber();let row=db.prepare("SELECT number,hash FROM blocks ORDER BY number DESC LIMIT 1").get() as {number:number;hash:string}|undefined;
    let rebuilt=false;if(row){const canonical=await provider.getBlock(row.number);if(!canonical||canonical.hash!==row.hash){reset();row=undefined;rebuilt=true;}}
    const from=Math.max(options.startBlock??0,(row?.number??((options.startBlock??0)-1))+1);
    if(from>head){const finalized=await stageFinalized(head);atomic(()=>writeFinalized(finalized));for(const item of finalized?.rows??[])finalizedRisk.update(item);return {accounts:new Set<string>(),reset:rebuilt};}
    // Stage every network read before opening a synchronous transaction. A failed
    // read or crash cannot advance the checkpoint past incomplete projections.
    const to=Math.min(head,from+9_999),logs=(await provider.getLogs({address:options.clearingAddress,fromBlock:from,toBlock:to})).sort((left,right)=>left.blockNumber-right.blockNumber||left.index-right.index),affected=new Map<string,{tx:string;block:number}>(),numbers=[...new Set([...logs.map(log=>log.blockNumber),to])],headers=await Promise.all(numbers.map(number=>provider.getBlock(number))),timestamps=new Map<number,number>(),activityPositions=new Map<string,IndexedPosition>();
    for(const block of headers){if(!block?.hash)throw new Error("missing canonical header");timestamps.set(block.number,block.timestamp);}
    const events:Array<{log:Log;timestamp:number;kind:string;account:string|null;market:number|null;payload:string}>=[];
    for(const log of logs){let parsed;try{parsed=iface.parseLog(log);}catch{continue}if(!parsed)continue;const timestamp=timestamps.get(log.blockNumber);if(timestamp===undefined)throw new Error(`missing block ${log.blockNumber}`);
      if(headers.find(header=>header?.number===log.blockNumber)?.hash!==log.blockHash)throw new Error("log/header divergence");
      const account=parsed.args.account?getAddress(parsed.args.account):null,market=parsed.args.market===undefined?null:Number(parsed.args.market),payloadObject=parsed.args.toObject() as Record<string,unknown>;
      if(account&&market!==null&&(parsed.name==="TradeExecuted"||parsed.name==="PositionClosed")){
        const key=`${account}:${market}`;let previous=activityPositions.get(key);
        if(!previous){const row=db.prepare("SELECT btc_size,btc_entry,eth_size,eth_entry FROM accounts WHERE account=?").get(account) as Record<string,string>|undefined,prefix=market===0?"btc":"eth";previous={size:BigInt(row?.[`${prefix}_size`]??0),entryPrice:BigInt(row?.[`${prefix}_entry`]??0)};}
        const details=tradeDetails(previous,BigInt(String(payloadObject.baseDelta)),BigInt(String(payloadObject.price)),parsed.name==="TradeExecuted"?BigInt(String(payloadObject.fee)):0n),{next,...serializable}=details;activityPositions.set(key,next);Object.assign(payloadObject,serializable);
      }
      const payload=JSON.stringify(payloadObject,(_,value)=>typeof value==="bigint"?value.toString():value);
      events.push({log,timestamp,kind:parsed.name,account,market,payload});if(account)affected.set(account,{tx:log.transactionHash,block:log.blockNumber});
    }
    const included=await Promise.all([...affected].map(([account,event])=>readAccount(account,event.block,event.tx)));
    const finalized=await stageFinalized(head,to,events.filter(event=>event.account).map(event=>({account:event.account!,block:event.log.blockNumber})));
    const tip=headers.find(header=>header?.number===to),canonical=await provider.getBlock(to);
    if(!tip||canonical?.hash!==tip.hash)throw new Error("chain changed before checkpoint commit");
    atomic(()=>{
      for(const block of headers)db.prepare("INSERT OR REPLACE INTO blocks VALUES(?,?,?,?)").run(block!.number,block!.hash,block!.parentHash,block!.timestamp);
      for(const {log,timestamp,kind,account,market,payload} of events)db.prepare("INSERT OR REPLACE INTO activity VALUES(?,?,?,?,?,?,?,?,?)").run(log.transactionHash,log.index,log.blockNumber,log.blockHash,timestamp,kind,account,market,payload);
      for(const item of included)writeAccount(item,"accounts");writeFinalized(finalized);
    });
    for(const item of included)liveRisk.update(item);for(const item of finalized?.rows??[])finalizedRisk.update(item);
    return {accounts:new Set(affected.keys()),reset:rebuilt};
  }
  async function doSync(){
    for(let attempt=0;attempt<3;attempt++){
      const result=await syncPass();
      const row=db.prepare("SELECT number,hash FROM blocks ORDER BY number DESC LIMIT 1").get() as {number:number;hash:string}|undefined;
      if(!row)return result;
      const canonical=await provider.getBlock(row.number);
      if(canonical?.hash===row.hash)return result;
      reset();
    }
    throw new Error("chain changed during three consecutive index passes");
  }
  async function sync(){if(syncing)return syncing;syncing=doSync().then(result=>{lastError=undefined;publishUpdate(result.accounts,result.reset);return result}).catch(error=>{lastError=String(error);return {accounts:new Set<string>(),reset:false}}).finally(()=>{syncing=undefined});return syncing;}
  const limitFrom=(value:string|undefined,fallback=25)=>{const parsed=Number(value??fallback);return Number.isSafeInteger(parsed)?Math.min(100,Math.max(1,parsed)):fallback;};
  const cursorFrom=(value:string|undefined)=>{const parts=(value??`${Number.MAX_SAFE_INTEGER}:${Number.MAX_SAFE_INTEGER}`).split(":").map(Number);return parts.length===2&&parts.every(Number.isSafeInteger)?parts:null;};
  const finalityBlock=async()=>Math.max((options.startBlock??0)-1,(await provider.getBlockNumber())-(options.confirmations??2));
  app.get("/health",async()=>{await sync();const head=await provider.getBlockNumber();const indexed=(db.prepare("SELECT max(number) value FROM blocks").get() as {value:number|null}).value??((options.startBlock??0)-1);const finalized=Math.max((options.startBlock??0)-1,head-(options.confirmations??2));return {ok:!lastError,indexedBlock:indexed,finalizedBlock:Math.min(indexed,finalized),headBlock:head,lag:head-indexed,error:lastError?"index_sync_failed":undefined};});
  app.get("/v1/updates/stream",async(request,reply)=>{reply.hijack();reply.raw.writeHead(200,{"content-type":"text/event-stream","cache-control":"no-cache, no-transform","connection":"keep-alive","access-control-allow-origin":originFor(request.headers.origin)});updateClients.add(reply.raw);request.raw.on("close",()=>updateClients.delete(reply.raw));reply.raw.write(`event: indexed\ndata: ${JSON.stringify({indexedBlock:indexedBlock(),changed:true,initial:true,accounts:[]})}\n\n`);});
  app.get("/v1/account/:address",async(request,reply)=>{await sync();let account;try{account=getAddress((request.params as {address:string}).address);}catch{return reply.code(400).send({error:"invalid account"});}const row=db.prepare("SELECT * FROM accounts WHERE account=?").get(account) as Record<string,string|number>|undefined;if(!row)return reply.code(404).send({error:"account not indexed"});return {account,collateral:row.collateral,positions:{BTC:{size:row.btc_size,entryPrice:row.btc_entry},ETH:{size:row.eth_size,entryPrice:row.eth_entry}},indexedBlock:row.indexed_block,indexedTransaction:row.indexed_tx};});
  app.get("/v1/account/:address/activity",async(request,reply)=>{await sync();let account;try{account=getAddress((request.params as {address:string}).address);}catch{return reply.code(400).send({error:"invalid account"});}const query=request.query as {cursor?:string;limit?:string};const cursor=cursorFrom(query.cursor);if(!cursor)return reply.code(400).send({error:"invalid cursor"});const [cursorBlock,cursorLog]=cursor;const limit=limitFrom(query.limit);const rows=db.prepare("SELECT * FROM activity WHERE account=? AND (block_number<? OR (block_number=? AND log_index<?)) ORDER BY block_number DESC,log_index DESC LIMIT ?").all(account,cursorBlock,cursorBlock,cursorLog,limit) as Array<Record<string,string|number>>;const finalized=await finalityBlock();return {items:rows.map(row=>({...row,payload:JSON.parse(String(row.payload)),finality:Number(row.block_number)<=finalized?"finalized":"included"})),nextCursor:rows.length===limit?`${rows[rows.length-1].block_number}:${rows[rows.length-1].log_index}`:null};});
  app.get("/v1/activity",async(request,reply)=>{await sync();const query=request.query as {cursor?:string;limit?:string;kind?:string;market?:string;finalized?:string};const cursor=cursorFrom(query.cursor);if(!cursor)return reply.code(400).send({error:"invalid cursor"});const [cursorBlock,cursorLog]=cursor;const limit=limitFrom(query.limit);const allowedKinds=["Deposited","Withdrawn","NonceCancelled","SessionGranted","SessionRevoked","TradeExecuted","FundingSettled","PositionClosed","Liquidated","DeficitAbsorbed","MakerWithdrawn","EpochAdvanced","ResolutionStarted","ResolutionPriceReady","ResolutionFinalized"];
    if(query.kind&&!allowedKinds.includes(query.kind))return reply.code(400).send({error:"invalid activity kind"});const market=query.market===undefined?undefined:Number(query.market);if(market!==undefined&&market!==0&&market!==1)return reply.code(400).send({error:"invalid market"});
    const finalized=await finalityBlock();const clauses=["(block_number<? OR (block_number=? AND log_index<?))"],params:Array<string|number>=[cursorBlock,cursorBlock,cursorLog];if(query.finalized==="true"){clauses.push("block_number<=?");params.push(finalized);}if(query.kind){clauses.push("kind=?");params.push(query.kind);}if(market!==undefined){clauses.push("market=?");params.push(market);}params.push(limit);
    const rows=db.prepare(`SELECT * FROM activity WHERE ${clauses.join(" AND ")} ORDER BY block_number DESC,log_index DESC LIMIT ?`).all(...params) as Array<Record<string,string|number>>;return {items:rows.map(row=>({...row,payload:JSON.parse(String(row.payload)),finality:Number(row.block_number)<=finalized?"finalized":"included"})),nextCursor:rows.length===limit?`${rows[rows.length-1].block_number}:${rows[rows.length-1].log_index}`:null,finalizedBlock:finalized};});
  app.get("/v1/exposure",async(request)=>{await sync();const head=await provider.getBlockNumber();const query=request.query as {finalized?:string};const blockTag=query.finalized==="true"?Math.max(options.startBlock??0,head-(options.confirmations??2)):head;const [btc,eth]=await Promise.all([contract.markets(0,{blockTag}),contract.markets(1,{blockTag})]);return {blockNumber:blockTag,markets:{BTC:{aggregateBase:btc.aggregateBase.toString(),bid:btc.lastBid.toString(),ask:btc.lastAsk.toString()},ETH:{aggregateBase:eth.aggregateBase.toString(),bid:eth.lastBid.toString(),ask:eth.lastAsk.toString()}}};});
  app.get("/v1/risk",async(request)=>{await sync();const finalized=(request.query as {finalized?:string}).finalized==="true",block=finalized?Number((db.prepare("SELECT value FROM metadata WHERE key=\'finalized_cursor\'").get() as {value:string}|undefined)?.value??((options.startBlock??0)-1)):indexedBlock();return (finalized?finalizedRisk:liveRisk).snapshot(block);});
  app.get("/v1/positions",async(request,reply)=>{await sync();const query=request.query as {limit?:string;cursor?:string;finalized?:string;market?:string};const limit=limitFrom(query.limit,50),finalized=query.finalized!=="false",table=finalized?"finalized_accounts":"accounts";if(query.market&&!['BTC','ETH'].includes(query.market))return reply.code(400).send({error:"invalid market"});let cursor:string|undefined;if(query.cursor){try{cursor=getAddress(query.cursor);}catch{return reply.code(400).send({error:"invalid cursor"});}}const open=query.market==="BTC"?"btc_size != '0'":query.market==="ETH"?"eth_size != '0'":"(btc_size != '0' OR eth_size != '0')",where=cursor?`${open} AND account > ?`:open,params=cursor?[cursor,limit]:[limit],rows=db.prepare(`SELECT account,collateral,btc_size,btc_entry,eth_size,eth_entry,indexed_block FROM ${table} WHERE ${where} ORDER BY account LIMIT ?`).all(...params) as Array<Record<string,string|number>>,total=Number((db.prepare(`SELECT count(*) value FROM ${table} WHERE ${open}`).get() as {value:number}).value),block=finalized?Number((db.prepare("SELECT value FROM metadata WHERE key='finalized_cursor'").get() as {value:string}|undefined)?.value??((options.startBlock??0)-1)):indexedBlock(),items=rows.map(row=>({account:String(row.account),collateral:String(row.collateral),positions:{BTC:{size:String(row.btc_size),entryPrice:String(row.btc_entry)},ETH:{size:String(row.eth_size),entryPrice:String(row.eth_entry)}}}));return {items,total,nextCursor:items.length===limit?items[items.length-1].account:null,indexedBlock:block,finality:finalized?"finalized":"included"};});
  app.get("/v1/protocol",async()=>{await sync();const blockNumber=await provider.getBlockNumber();const [epoch,signerSetVersion,policyVersion,paused,resolutionRequired]=await Promise.all([contract.leaderEpoch(),contract.signerSetVersion(),contract.policyVersion(),contract.paused(),contract.resolutionRequired()]);return {blockNumber,leaderEpoch:epoch.toString(),signerSetVersion:signerSetVersion.toString(),policyVersion:policyVersion.toString(),paused,resolutionRequired};});
  app.addHook("onReady",async()=>{await sync();timer=setInterval(()=>void sync(),options.pollMs??500);timer.unref();heartbeat=setInterval(()=>{for(const client of updateClients)client.write(": heartbeat\n\n");},15_000);heartbeat.unref();});app.addHook("onClose",async()=>{if(timer)clearInterval(timer);if(heartbeat)clearInterval(heartbeat);for(const client of updateClients)client.end();await syncing;db.close();});return app;
}
