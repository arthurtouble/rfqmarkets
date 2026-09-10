import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { Wallet } from "ethers";

type Identity={address:string;privateKey:string};
type Account={positions:{ETH:{size:string}}};
type HedgeOrder={client_id:string;market:string;base_delta:string;status:string;venue_order_id:string|null;filled_base:string;reason:string|null;created_ms:number};
type HedgeStatus={healthy:boolean;error?:string;positions:{ETH:string};markets:{ETH:{customerBase:string;venueBase:string;gapNotional:string}};orders:HedgeOrder[]};

const required=(name:string)=>{const value=process.env[name];if(!value||value.startsWith("replace_"))throw new Error(`missing ${name}`);return value;};
required("PYTH_API_KEY");required("RFQ_BASE_SEPOLIA_RPC_URL");required("RFQ_HYPERLIQUID_ACCOUNT_ADDRESS");required("RFQ_HYPERLIQUID_AGENT_NAME");
const identities=JSON.parse(readFileSync(resolve(".local-state/testnet-identities.json"),"utf8")) as {sponsor:Identity};
const wallet=new Wallet(identities.sponsor.privateKey),runtime=mkdtempSync(join(tmpdir(),"rfq-base-hl-e2e-")),base=51_000+Math.floor(Math.random()*1_000),api=`http://127.0.0.1:${base}`,indexer=`http://127.0.0.1:${base+200}`,hedger=`http://127.0.0.1:${base+300}`;
let output="";
const fastPrimary="https://base-sepolia-rpc.publicnode.com",independentSecondary=process.env.RFQ_BASE_SEPOLIA_RPC_URL!;
const child=spawn(process.execPath,["--import","tsx",resolve("scripts/base-sepolia-stack.ts")],{cwd:resolve("."),stdio:["ignore","pipe","pipe"],env:{...process.env,NODE_ENV:"test",RFQ_API_PORT:String(base),RFQ_APPROVER_BASE_PORT:String(base+100),RFQ_INDEXER_PORT:String(base+200),RFQ_HEDGER_PORT:String(base+300),RFQ_GATEWAY_PORT:String(base+400),RFQ_TESTNET_RUNTIME_DIR:runtime,RFQ_API_RPC_URL:fastPrimary,RFQ_APPROVER_RPC_URLS:[fastPrimary,fastPrimary,fastPrimary].join(","),RFQ_APPROVER_SECONDARY_RPC_URLS:[independentSecondary,independentSecondary,independentSecondary].join(","),RFQ_APPROVER_RPC_BATCH_MAX_COUNT:"20",RFQ_HEDGE_VENUE:"hyperliquid-testnet",RFQ_HEDGE_BAND_USDC:"1",RFQ_HEDGE_MIN_ORDER_USDC:"10",RFQ_HEDGE_MAX_ORDER_USDC:"25"}});
child.stdout?.on("data",chunk=>{output+=String(chunk);});child.stderr?.on("data",chunk=>{output+=String(chunk);});

const sleep=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
async function json(url:string,init?:RequestInit){const response=await fetch(url,{...init,signal:AbortSignal.timeout(30_000)}),body=await response.json();assert(response.ok,`${url}: ${response.status} ${JSON.stringify(body)}; stack=${output.slice(-2_000)}`);return body;}
async function post(path:string,body:Record<string,unknown>){return json(`${api}${path}`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)});}
async function waitFor<T>(label:string,read:()=>Promise<T>,accept:(value:T)=>boolean,timeoutMs=180_000){const end=Date.now()+timeoutMs;let last:T|undefined;while(Date.now()<end){if(child.exitCode!==null)throw new Error(`stack exited ${child.exitCode}: ${output.slice(-2_000)}`);try{last=await read();if(accept(last))return last;}catch{}await sleep(1_000);}throw new Error(`${label} timed out; last=${JSON.stringify(last)}; stack=${output.slice(-2_000)}`);}
const nonce=()=>BigInt(`0x${crypto.randomUUID().replaceAll("-","")}`).toString();
async function closeEth(){const quote=await waitFor("fresh close quote",()=>post("/v1/close/quote",{account:wallet.address,market:"ETH"}),value=>Date.now()-Number(value.observedAtMs)<=4_500,30_000),closeNonce=nonce(),prepared=await post("/v1/prepare",{quoteId:quote.quoteId,account:wallet.address,nonce:closeNonce,reduceOnly:true}),signature=await wallet.signTypedData(prepared.domain,prepared.types,prepared.intent);return post("/v1/approve",{quoteId:quote.quoteId,account:wallet.address,nonce:closeNonce,reduceOnly:true,userSignature:signature});}
async function waitFlat(){await waitFor("finalized customer and venue flatten",()=>json(hedger+"/v1/status") as Promise<HedgeStatus>,status=>status.healthy&&status.markets.ETH.customerBase==="0"&&status.positions.ETH==="0");}
async function stop(process:ChildProcess){if(process.exitCode!==null)return;process.kill("SIGTERM");await Promise.race([new Promise<void>(resolve=>process.once("exit",()=>resolve())),sleep(8_000).then(()=>{if(process.exitCode===null)process.kill("SIGKILL");})]);}

try{
  await waitFor("stack readiness",()=>json(api+"/health"),()=>output.includes("services ready"),180_000);
  await waitFor("healthy hedge loop",()=>json(hedger+"/v1/status") as Promise<HedgeStatus>,status=>status.healthy&&status.markets.ETH.customerBase!==undefined);
  const initial=await json(`${api}/v1/account/${wallet.address}`) as Account,initialHedge=await json(hedger+"/v1/status") as HedgeStatus;
  console.log(JSON.stringify({initial:{accountEth:initial.positions.ETH.size,customerEth:initialHedge.markets.ETH.customerBase,venueEth:initialHedge.positions.ETH,gapNotional:initialHedge.markets.ETH.gapNotional}}));
  if(initial.positions.ETH.size!=="0")await closeEth();
  if(initial.positions.ETH.size!=="0"||initialHedge.positions.ETH!=="0")await waitFlat();

  const started=Date.now(),quote=await waitFor("fresh firm quote",()=>post("/v1/quote",{market:"ETH",side:"buy",amount:"11.5"}),value=>Date.now()-Number(value.observedAtMs)<=4_500,30_000);console.log(JSON.stringify({quoteObservedAtMs:Number(quote.observedAtMs),quoteAgeMs:Date.now()-Number(quote.observedAtMs)}));const tradeNonce=nonce(),prepared=await post("/v1/prepare",{quoteId:quote.quoteId,account:wallet.address,nonce:tradeNonce}),signature=await wallet.signTypedData(prepared.domain,prepared.types,prepared.intent),approvalStarted=Date.now();let execution;try{execution=await post("/v1/approve",{quoteId:quote.quoteId,account:wallet.address,nonce:tradeNonce,userSignature:signature});}catch(error){console.log(JSON.stringify({approvalFailureAfterMs:Date.now()-approvalStarted}));throw error;}console.log(JSON.stringify({approvalToInclusionMs:Date.now()-approvalStarted}));
  assert.match(execution.transaction.hash,/^0x[0-9a-f]{64}$/i);
  const opened=await waitFor("finalized customer exposure and venue hedge",()=>json(hedger+"/v1/status") as Promise<HedgeStatus>,status=>status.healthy&&BigInt(status.markets.ETH.customerBase)>0n&&BigInt(status.positions.ETH)>0n);
  const openingOrders=opened.orders.filter(order=>order.market==="ETH"&&order.status==="filled"&&BigInt(order.base_delta)>0n&&order.reason===null);
  assert(openingOrders.length>0,"no filled opening hedge was journaled");

  const close=await closeEth();assert.match(close.transaction.hash,/^0x[0-9a-f]{64}$/i);
  const flat=await waitFor("finalized close and venue unwind",()=>json(hedger+"/v1/status") as Promise<HedgeStatus>,status=>status.healthy&&status.markets.ETH.customerBase==="0"&&status.positions.ETH==="0");
  const orders=flat.orders.filter(order=>order.market==="ETH"&&order.created_ms>=started);
  const closingOrders=orders.filter(order=>order.status==="filled"&&BigInt(order.base_delta)<0n&&order.reason===null);
  assert(closingOrders.length>0,"no filled closing hedge was journaled");assert.equal(new Set(orders.map(order=>order.client_id)).size,orders.length,"duplicate hedge client IDs");assert(orders.every(order=>order.venue_order_id),"a hedge lacks a venue order ID");
  const indexed=await json(`${indexer}/v1/account/${wallet.address}`) as Account;assert.equal(indexed.positions.ETH.size,"0");
  console.log(JSON.stringify({verified:true,market:"ETH",customerNotionalUsdc:"11.5",tradeTransaction:execution.transaction.hash,closeTransaction:close.transaction.hash,openingHedgeOrders:openingOrders.map(order=>({clientId:order.client_id,venueOrderId:order.venue_order_id,filledBase:order.filled_base})),closingHedgeOrders:closingOrders.map(order=>({clientId:order.client_id,venueOrderId:order.venue_order_id,filledBase:order.filled_base})),finalCustomerBase:flat.markets.ETH.customerBase,finalVenueBase:flat.positions.ETH},null,2));
}finally{
  try{const account=await json(`${api}/v1/account/${wallet.address}`) as Account;if(account.positions.ETH.size!=="0"){await closeEth();await waitFlat();}}catch(error){console.error(`cleanup warning: ${String(error)}`);}
  await stop(child);
  rmSync(runtime,{recursive:true,force:true});
}
