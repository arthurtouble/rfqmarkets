import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildHedger, type HedgeMarket, type HedgeVenue, type VenueOrder, type VenueResult } from "./server.js";

test("hedges finalized aggregate exposure once with a stable client order id",async()=>{
  const directory=mkdtempSync(join(tmpdir(),"rfq-hedger-"));
  const payload={blockNumber:50,markets:{BTC:{aggregateBase:"1000000000000000000",bid:"99990000000",ask:"100010000000"},ETH:{aggregateBase:"0",bid:"0",ask:"0"}}};
  const fetchImpl=(async()=>new Response(JSON.stringify(payload),{status:200,headers:{"content-type":"application/json"}})) as typeof fetch;
  const hedge=buildHedger({indexerUrl:"http://indexer",databasePath:join(directory,"hedge.sqlite"),fetchImpl,pollMs:60_000});await hedge.ready();
  const first=(await hedge.inject({method:"GET",url:"/v1/status"})).json();assert.equal(first.orders.length,1);assert.equal(first.orders[0].status,"filled");assert.equal(first.positions.BTC,"250000000000000000");
  await hedge.inject({method:"POST",url:"/v1/tick"});const second=(await hedge.inject({method:"GET",url:"/v1/status"})).json();assert.equal(second.orders.length,2);assert.equal(second.positions.BTC,"500000000000000000");
  await hedge.close();const restarted=buildHedger({indexerUrl:"http://indexer",databasePath:join(directory,"hedge.sqlite"),fetchImpl,pollMs:60_000});await restarted.ready();const recovered=(await restarted.inject({method:"GET",url:"/v1/status"})).json();assert.equal(recovered.orders.length,3);assert.equal(recovered.positions.BTC,"750000000000000000");
  await restarted.inject({method:"POST",url:"/v1/tick"});const stable=(await restarted.inject({method:"GET",url:"/v1/status"})).json();assert.equal(stable.orders.length,3);assert.equal(stable.positions.BTC,recovered.positions.BTC);
  await restarted.close();rmSync(directory,{recursive:true,force:true});
});

test("reconciles a lost partial-fill acknowledgement before submitting another slice",async()=>{
  class PartialVenue implements HedgeVenue{
    readonly mode="fault-injection";positions:Record<HedgeMarket,bigint>={BTC:0n,ETH:0n};orders=new Map<string,VenueResult>();submissions=0;lose=true;
    async position(market:HedgeMarket){return this.positions[market];}async find(id:string){return this.orders.get(id)??null;}
    async submit(order:VenueOrder){this.submissions++;const filled=order.baseDelta/2n,result:VenueResult={venueOrderId:`venue-${this.submissions}`,status:"partial",filledBase:filled};this.orders.set(order.clientId,result);this.positions[order.market]+=filled;if(this.lose){this.lose=false;throw new Error("acknowledgement lost");}return result;}
  }
  const directory=mkdtempSync(join(tmpdir(),"rfq-partial-")),venue=new PartialVenue(),payload={blockNumber:70,markets:{BTC:{aggregateBase:"1000000000000000000",bid:"99990000000",ask:"100010000000"},ETH:{aggregateBase:"0",bid:"0",ask:"0"}}},fetchImpl=(async()=>new Response(JSON.stringify(payload),{status:200,headers:{"content-type":"application/json"}})) as typeof fetch;
  const hedge=buildHedger({indexerUrl:"http://indexer",databasePath:join(directory,"hedge.sqlite"),fetchImpl,pollMs:60_000,venue});await hedge.ready();let status=(await hedge.inject({method:"GET",url:"/v1/status"})).json();assert.equal(status.healthy,false);assert.equal(venue.submissions,1);
  await hedge.inject({method:"POST",url:"/v1/tick"});status=(await hedge.inject({method:"GET",url:"/v1/status"})).json();assert.equal(status.healthy,true);assert.equal(status.orders.some((order:{status:string})=>order.status==="partial"),true);assert.equal(venue.submissions,2,"lost acknowledgement caused duplicate submission");assert(BigInt(status.positions.BTC)>0n);
  await hedge.close();rmSync(directory,{recursive:true,force:true});
});

test("does not stack hedge slices while a venue order remains open",async()=>{
  class OpenVenue implements HedgeVenue{
    readonly mode="open-order-test";submissions=0;orders=new Map<string,VenueResult>();
    async position(){return 0n;}async find(id:string){return this.orders.get(id)??null;}
    async submit(order:VenueOrder){this.submissions++;const result:VenueResult={venueOrderId:`open-${this.submissions}`,status:"open",filledBase:0n};this.orders.set(order.clientId,result);return result;}
  }
  const directory=mkdtempSync(join(tmpdir(),"rfq-open-")),venue=new OpenVenue(),payload={blockNumber:80,markets:{BTC:{aggregateBase:"1000000000000000000",bid:"99990000000",ask:"100010000000"},ETH:{aggregateBase:"0",bid:"0",ask:"0"}}},fetchImpl=(async()=>new Response(JSON.stringify(payload),{status:200,headers:{"content-type":"application/json"}})) as typeof fetch;
  const hedge=buildHedger({indexerUrl:"http://indexer",databasePath:join(directory,"hedge.sqlite"),fetchImpl,pollMs:60_000,venue});await hedge.ready();
  await hedge.inject({method:"POST",url:"/v1/tick"});await hedge.inject({method:"POST",url:"/v1/tick"});
  const status=(await hedge.inject({method:"GET",url:"/v1/status"})).json();assert.equal(status.orders.length,1);assert.equal(status.orders[0].status,"open");assert.equal(venue.submissions,1);
  await hedge.close();rmSync(directory,{recursive:true,force:true});
});

test("venue rejection is journaled with its reason and fails quote admission closed",async()=>{
  class RejectingVenue implements HedgeVenue{
    readonly mode="rejecting-test";
    async position(){return 0n;}async find(){return null;}
    async submit():Promise<VenueResult>{return {venueOrderId:"rejected-1",status:"rejected",filledBase:0n,reason:"insufficient margin"};}
  }
  const directory=mkdtempSync(join(tmpdir(),"rfq-rejected-")),payload={blockNumber:81,markets:{BTC:{aggregateBase:"1000000000000000000",bid:"99990000000",ask:"100010000000"},ETH:{aggregateBase:"0",bid:"0",ask:"0"}}},fetchImpl=(async()=>new Response(JSON.stringify(payload),{status:200})) as typeof fetch;
  const hedge=buildHedger({indexerUrl:"http://indexer",databasePath:join(directory,"hedge.sqlite"),fetchImpl,pollMs:60_000,venue:new RejectingVenue(),healthToken:"risk-secret"});await hedge.ready();
  const status=(await hedge.inject({method:"GET",url:"/v1/status"})).json(),risk=(await hedge.inject({method:"GET",url:"/internal/risk",headers:{authorization:"Bearer risk-secret"}})).json();
  assert.equal(status.healthy,false);assert.match(status.error,/insufficient margin/);assert.equal(status.orders[0].status,"rejected");assert.equal(status.orders[0].reason,"insufficient margin");assert.equal(risk.markets.BTC.mode,"reduce_only");
  await hedge.close();rmSync(directory,{recursive:true,force:true});
});

test("protected risk endpoint reports normal, guarded and reduce-only operating modes",async()=>{
  for(const [name,aggregateBase,expected] of [["normal","300000000000000000","normal"],["guarded","650000000000000000","guarded"],["reduce","1000000000000000000","reduce_only"]] as const){
    const directory=mkdtempSync(join(tmpdir(),`rfq-risk-${name}-`)),payload={blockNumber:90,markets:{BTC:{aggregateBase,bid:"99990000000",ask:"100010000000"},ETH:{aggregateBase:"0",bid:"0",ask:"0"}}},fetchImpl=(async()=>new Response(JSON.stringify(payload),{status:200})) as typeof fetch;
    const hedge=buildHedger({indexerUrl:"http://indexer",databasePath:join(directory,"hedge.sqlite"),fetchImpl,pollMs:60_000,healthToken:"risk-secret"});await hedge.ready();
    assert.equal((await hedge.inject({method:"GET",url:"/internal/risk"})).statusCode,401);const response=await hedge.inject({method:"GET",url:"/internal/risk",headers:{authorization:"Bearer risk-secret"}});assert.equal(response.statusCode,200,response.body);const risk=response.json();assert.equal(risk.healthy,true);assert.equal(risk.indexedBlock,90);assert.equal(risk.markets.BTC.mode,expected);
    await hedge.close();rmSync(directory,{recursive:true,force:true});
  }
});

test("risk endpoint fails closed when finalized exposure cannot be read",async()=>{
  const directory=mkdtempSync(join(tmpdir(),"rfq-risk-failure-")),fetchImpl=(async()=>new Response("offline",{status:503})) as typeof fetch,hedge=buildHedger({indexerUrl:"http://indexer",databasePath:join(directory,"hedge.sqlite"),fetchImpl,pollMs:60_000,healthToken:"risk-secret"});await hedge.ready();
  const risk=(await hedge.inject({method:"GET",url:"/internal/risk",headers:{authorization:"Bearer risk-secret"}})).json();assert.equal(risk.healthy,false);assert.equal(risk.markets.BTC.mode,"reduce_only");await hedge.close();rmSync(directory,{recursive:true,force:true});
});
