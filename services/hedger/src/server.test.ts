import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildHedger } from "./server.js";

test("hedges finalized aggregate exposure once with a stable client order id",async()=>{
  const directory=mkdtempSync(join(tmpdir(),"rfq-hedger-"));
  const payload={blockNumber:50,markets:{BTC:{aggregateBase:"1000000000000000000",bid:"99990000000",ask:"100010000000"},ETH:{aggregateBase:"0",bid:"0",ask:"0"}}};
  const fetchImpl=(async()=>new Response(JSON.stringify(payload),{status:200,headers:{"content-type":"application/json"}})) as typeof fetch;
  const hedge=buildHedger({indexerUrl:"http://indexer",databasePath:join(directory,"hedge.sqlite"),fetchImpl,pollMs:60_000});await hedge.ready();
  const first=(await hedge.inject({method:"GET",url:"/v1/status"})).json();assert.equal(first.orders.length,1);assert.equal(first.orders[0].status,"filled");assert.equal(first.positions.BTC,"250000000000000000");
  await hedge.inject({method:"POST",url:"/v1/tick"});const second=(await hedge.inject({method:"GET",url:"/v1/status"})).json();assert.equal(second.orders.length,1);assert.equal(second.positions.BTC,first.positions.BTC);
  await hedge.close();const restarted=buildHedger({indexerUrl:"http://indexer",databasePath:join(directory,"hedge.sqlite"),fetchImpl,pollMs:60_000});await restarted.ready();const recovered=(await restarted.inject({method:"GET",url:"/v1/status"})).json();assert.equal(recovered.orders.length,1);assert.equal(recovered.positions.BTC,first.positions.BTC);
  await restarted.close();rmSync(directory,{recursive:true,force:true});
});
