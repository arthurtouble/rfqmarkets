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
