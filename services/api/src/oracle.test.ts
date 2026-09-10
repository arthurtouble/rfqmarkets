import assert from "node:assert/strict";
import { test } from "node:test";
import { AbiCoder } from "ethers";
import { ChainlinkDataStreamsSource, CoinbaseMarketDataSource, PythHermesSource } from "./oracle.js";

const feedId=`0x0003${"11".repeat(30)}`;
function report(observedAt=1_800_000_000){
  const coder=AbiCoder.defaultAbiCoder(),blob=coder.encode(["bytes32","uint32","uint32","uint192","uint192","uint32","int192","int192","int192"],[feedId,observedAt-1,observedAt,0,0,observedAt+10,100_000n*10n**8n,99_990n*10n**8n,100_010n*10n**8n]);
  return coder.encode(["bytes32[3]","bytes","bytes32[]","bytes32[]","bytes32"],[[`0x${"00".repeat(32)}`,`0x${"00".repeat(32)}`,`0x${"00".repeat(32)}`],blob,[],[],`0x${"00".repeat(32)}`]);
}

test("normalizes an official Data Streams v3 envelope to USDC decimals",async()=>{
  const fullReport=report(),source=new ChainlinkDataStreamsSource({apiKey:"test",userSecret:"secret",endpoint:"https://data.example",wsEndpoint:"wss://data.example",feedIds:{BTC:feedId,ETH:`0x0003${"22".repeat(30)}`},feedDecimals:{BTC:8,ETH:8},client:{getLatestReport:async()=>({feedID:feedId,fullReport,validFromTimestamp:1_799_999_999,observationsTimestamp:1_800_000_000})}});
  const value=await source.latest("BTC");assert.equal(value.snapshot.bid,99_990n*1_000_000n);assert.equal(value.snapshot.ask,100_010n*1_000_000n);assert.equal(value.snapshot.observedAtMs,1_800_000_000_000);assert.equal(value.report,fullReport);
});

test("rejects mismatched Data Streams response metadata",async()=>{
  const fullReport=report(),source=new ChainlinkDataStreamsSource({apiKey:"test",userSecret:"secret",endpoint:"https://data.example",wsEndpoint:"wss://data.example",feedIds:{BTC:feedId,ETH:`0x0003${"22".repeat(30)}`},feedDecimals:{BTC:8,ETH:8},client:{getLatestReport:async()=>({feedID:feedId,fullReport,validFromTimestamp:1_799_999_999,observationsTimestamp:1})}});
  await assert.rejects(source.latest("BTC"),/metadata mismatch/);
});

test("coalesces concurrent report acquisition per market",async()=>{
  const fullReport=report();let calls=0;const source=new ChainlinkDataStreamsSource({apiKey:"test",userSecret:"secret",endpoint:"https://data.example",wsEndpoint:"wss://data.example",feedIds:{BTC:feedId,ETH:`0x0003${"22".repeat(30)}`},feedDecimals:{BTC:8,ETH:8},client:{getLatestReport:async()=>{calls++;await new Promise(resolve=>setTimeout(resolve,5));return {feedID:feedId,fullReport,validFromTimestamp:1_799_999_999,observationsTimestamp:1_800_000_000};}}});
  await Promise.all(Array.from({length:20},()=>source.latest("BTC")));assert.equal(calls,1);
});

test("uses a fresh WebSocket report without another REST request",async()=>{
  const now=Math.floor(Date.now()/1_000),fullReport=report(now);let restCalls=0,listener:((value:any)=>void)|undefined,closed=false;
  const source=new ChainlinkDataStreamsSource({apiKey:"test",userSecret:"secret",endpoint:"https://data.example",wsEndpoint:"wss://data.example",feedIds:{BTC:feedId,ETH:`0x0003${"22".repeat(30)}`},feedDecimals:{BTC:8,ETH:8},client:{getLatestReport:async()=>{restCalls++;throw new Error("REST should not run");},createStream:()=>({on(_event,callback){listener=callback;return this;},connect:async()=>{listener?.({feedID:feedId,fullReport,validFromTimestamp:now-1,observationsTimestamp:now});},close:async()=>{closed=true;}})}});
  await source.start();const value=await source.latest("BTC");assert.equal(restCalls,0);assert.equal(value.snapshot.bid,99_990n*1_000_000n);await source.close();assert.equal(closed,true);
});

test("uses Coinbase WebSocket BBO and produces a local on-chain report",async()=>{
  const listeners:Record<string,Array<(event:any)=>void>>={},sent:string[]=[];let restCalls=0;
  const socket={readyState:1,send:(data:string)=>sent.push(data),close:()=>{},addEventListener:(type:string,listener:(event:any)=>void)=>{(listeners[type]??=[]).push(listener);}};
  const source=new CoinbaseMarketDataSource({socketFactory:()=>socket,fetchImpl:async()=>{restCalls++;throw new Error("REST should not run");}});
  await source.start();listeners.open[0]({});assert.equal(sent.length,2);
  listeners.message[0]({data:JSON.stringify({channel:"ticker",events:[{tickers:[{product_id:"BTC-USD",best_bid:"60123.12",best_ask:"60123.45"}]}]})});
  const quote=await source.latest("BTC");assert.equal(restCalls,0);assert.equal(quote.snapshot.bid,60_123_120_000n);assert.equal(quote.snapshot.ask,60_123_450_000n);assert.equal(quote.snapshot.source,"coinbase");
  listeners.message[0]({data:JSON.stringify({channel:"ticker",events:[{tickers:[{product_id:"BTC-USD",best_bid:"60723.12",best_ask:"60723.45"}]}]})});
  const moved=await source.latest("BTC");assert((moved.snapshot.volatilityBps??0)>90);
  const decoded=AbiCoder.defaultAbiCoder().decode(["tuple(uint8 market,uint256 bid,uint256 ask,uint64 observedAt,uint64 validUntil)"],quote.report)[0];assert.equal(decoded.market,0n);assert.equal(decoded.bid,quote.snapshot.bid);assert(decoded.validUntil>decoded.observedAt);
  await source.close();
});

test("publishes upstream WebSocket changes to stream consumers",async()=>{
  const listeners:Record<string,Array<(event:any)=>void>>={},socket={readyState:1,send:()=>{},close:()=>{},addEventListener:(type:string,listener:(event:any)=>void)=>{(listeners[type]??=[]).push(listener);}};
  const source=new CoinbaseMarketDataSource({socketFactory:()=>socket});let changed:string|undefined;const unsubscribe=source.subscribe(market=>{changed=market});await source.start();
  listeners.message[0]({data:JSON.stringify({channel:"ticker",events:[{tickers:[{product_id:"ETH-USD",best_bid:"3000",best_ask:"3001"}]}]})});assert.equal(changed,"ETH");unsubscribe();changed=undefined;
  listeners.message[0]({data:JSON.stringify({channel:"ticker",events:[{tickers:[{product_id:"BTC-USD",best_bid:"60000",best_ask:"60001"}]}]})});assert.equal(changed,undefined);await source.close();
});

test("falls back to Coinbase REST when the WebSocket snapshot is absent",async()=>{
  let calls=0;const source=new CoinbaseMarketDataSource({socketFactory:()=>({readyState:0,send:()=>{},close:()=>{},addEventListener:()=>{}}),fetchImpl:async url=>{calls++;assert.match(String(url),/ETH-USD\/ticker$/);return new Response(JSON.stringify({bid:"3999.10",ask:"4000.20"}),{status:200});}});
  const quote=await source.latest("ETH");assert.equal(calls,1);assert.equal(quote.snapshot.bid,3_999_100_000n);assert.equal(quote.snapshot.ask,4_000_200_000n);
});

test("authenticates, batches and encodes Pyth Core Hermes updates",async()=>{
  const now=Math.floor(Date.now()/1_000),btc=`0x${"11".repeat(32)}`,eth=`0x${"22".repeat(32)}`;let calls=0,authorization="";
  const source=new PythHermesSource({apiKey:"trial-secret",feedIds:{BTC:btc,ETH:eth},fetchImpl:async(_url,init)=>{calls++;authorization=new Headers(init?.headers).get("authorization")??"";return new Response(JSON.stringify({binary:{encoding:"hex",data:["abcd"]},parsed:[{id:btc.slice(2),price:{price:"10000000000000",conf:"1000000000",expo:-8,publish_time:now}},{id:eth.slice(2),price:{price:"300000000000",conf:"100000000",expo:-8,publish_time:now}}]}));}});
  const [btcQuote,ethQuote]=await Promise.all([source.latest("BTC"),source.latest("ETH")]);assert.equal(calls,1);assert.equal(authorization,"Bearer trial-secret");assert.equal(btcQuote.snapshot.bid,99_990_000_000n);assert.equal(btcQuote.snapshot.ask,100_010_000_000n);assert.equal(ethQuote.snapshot.source,"pyth-core");
  const [market,updates]=AbiCoder.defaultAbiCoder().decode(["uint8","bytes[]"],btcQuote.report);assert.equal(market,0n);assert.deepEqual([...updates],["0xabcd"]);
});

test("streams authenticated Pyth updates to subscribers",async()=>{
  const now=Math.floor(Date.now()/1_000),btc=`0x${"55".repeat(32)}`,eth=`0x${"66".repeat(32)}`,body={binary:{encoding:"hex",data:["abcd"]},parsed:[{id:btc.slice(2),price:{price:"8000000000000",conf:"100000000",expo:-8,publish_time:now}},{id:eth.slice(2),price:{price:"250000000000",conf:"10000000",expo:-8,publish_time:now}}]};let authorization="";
  const source=new PythHermesSource({apiKey:"trial-secret",feedIds:{BTC:btc,ETH:eth},fetchImpl:async(_url,init)=>{authorization=new Headers(init?.headers).get("authorization")??"";let controller:ReadableStreamDefaultController<Uint8Array>;const stream=new ReadableStream<Uint8Array>({start(value){controller=value;value.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(body)}\n\n`));}});init?.signal?.addEventListener("abort",()=>controller.close());return new Response(stream,{headers:{"content-type":"text/event-stream"}});}});
  const changed=new Promise<string>(resolve=>source.subscribe(resolve));await source.start();assert.equal(await changed,"BTC");assert.equal(authorization,"Bearer trial-secret");assert.equal((await source.latest("ETH")).snapshot.source,"pyth-core");await source.close();
});

test("rejects stale or incomplete Pyth Hermes observations",async()=>{
  const id=`0x${"33".repeat(32)}`,stale=Math.floor(Date.now()/1_000)-30,fetchImpl=async()=>new Response(JSON.stringify({binary:{encoding:"hex",data:["abcd"]},parsed:[{id,price:{price:"100000000",conf:"1",expo:-8,publish_time:stale}}]}));
  const source=new PythHermesSource({apiKey:"trial-secret",feedIds:{BTC:id,ETH:`0x${"44".repeat(32)}`},fetchImpl});await assert.rejects(source.latest("BTC"),/observation rejected|feed missing/);
});
