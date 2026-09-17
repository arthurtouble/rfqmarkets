import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { Contract, JsonRpcProvider, Wallet } from "ethers";

type Identity={address:string;privateKey:string};
type Account={positions:{ETH:{size:string}}};
type HedgeOrder={client_id:string;market:string;base_delta:string;status:string;venue_order_id:string|null;filled_base:string;reason:string|null;created_ms:number};
type HedgeStatus={healthy:boolean;error?:string;positions:Record<"BTC"|"ETH",string>;markets:Record<"BTC"|"ETH",{customerBase:string;venueBase:string;gapNotional:string}>;orders:HedgeOrder[]};
type HedgeRisk={healthy:boolean;markets:{ETH:{mode:"normal"|"guarded"|"reduce_only"}}};

const required=(name:string)=>{const value=process.env[name];if(!value||value.startsWith("replace_"))throw new Error(`missing ${name}`);return value;};
required("PYTH_API_KEY");required("RFQ_BASE_SEPOLIA_RPC_URL");required("RFQ_HYPERLIQUID_ACCOUNT_ADDRESS");required("RFQ_HYPERLIQUID_AGENT_NAME");
const identities=JSON.parse(readFileSync(resolve(".local-state/testnet-identities.json"),"utf8")) as {sponsor:Identity};
const wallet=new Wallet(identities.sponsor.privateKey),runtime=mkdtempSync(join(tmpdir(),"rfq-base-hl-e2e-")),base=51_000+Math.floor(Math.random()*1_000),api=`http://127.0.0.1:${base}`,indexer=`http://127.0.0.1:${base+200}`,hedger=`http://127.0.0.1:${base+300}`,hedgeToken=`hedge-e2e-${crypto.randomUUID()}`;
let output="";
const fastPrimary="https://base-sepolia-rpc.publicnode.com",independentSecondary=process.env.RFQ_BASE_SEPOLIA_RPC_URL!;
const deploymentPath=resolve(process.env.RFQ_BASE_SEPOLIA_DEPLOYMENT_FILE??".local-state/base-sepolia-deployment.json"),deploymentManifest=JSON.parse(readFileSync(deploymentPath,"utf8")) as Record<string,unknown>&{deploymentBlock?:number},qualificationHead=await new JsonRpcProvider(fastPrimary,undefined,{batchMaxCount:1}).getBlockNumber(),runtimeManifest={...deploymentManifest,deploymentBlock:Math.max(deploymentManifest.deploymentBlock??0,qualificationHead-20)};
const child=spawn(process.execPath,["--import","tsx",resolve("scripts/base-sepolia-stack.ts")],{cwd:resolve("."),stdio:["ignore","pipe","pipe"],env:{...process.env,NODE_ENV:"test",RFQ_TESTNET_MANIFEST_JSON:JSON.stringify(runtimeManifest),RFQ_API_PORT:String(base),RFQ_APPROVER_BASE_PORT:String(base+100),RFQ_INDEXER_PORT:String(base+200),RFQ_HEDGER_PORT:String(base+300),RFQ_GATEWAY_PORT:String(base+400),RFQ_TESTNET_RUNTIME_DIR:runtime,RFQ_API_RPC_URL:fastPrimary,RFQ_APPROVER_RPC_URLS:[fastPrimary,fastPrimary,fastPrimary].join(","),RFQ_APPROVER_SECONDARY_RPC_URLS:[independentSecondary,independentSecondary,independentSecondary].join(","),RFQ_APPROVER_RPC_BATCH_MAX_COUNT:"20",RFQ_APPROVER_TIMEOUT_MS:process.env.RFQ_APPROVER_TIMEOUT_MS??"30000",RFQ_HEDGE_RISK_MAX_AGE_MS:process.env.RFQ_HEDGE_RISK_MAX_AGE_MS??"30000",RFQ_HEDGE_OPS_TOKEN:hedgeToken,RFQ_HEDGE_VENUE:"hyperliquid-testnet",RFQ_HEDGE_BAND_USDC:"1",RFQ_HEDGE_MIN_ORDER_USDC:"10",RFQ_HEDGE_MAX_ORDER_USDC:"25"}});
child.stdout?.on("data",chunk=>{output+=String(chunk);});child.stderr?.on("data",chunk=>{output+=String(chunk);});

const sleep=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
async function json(url:string,init?:RequestInit){const headers=new Headers(init?.headers);if(url.startsWith(hedger))headers.set("authorization",`Bearer ${hedgeToken}`);const timeoutMs=url.endsWith("/v1/approve")?90_000:30_000,response=await fetch(url,{...init,headers,signal:AbortSignal.timeout(timeoutMs)}),body=await response.json();assert(response.ok,`${url}: ${response.status} ${JSON.stringify(body)}; stack=${output.slice(-2_000)}`);return body;}
async function post(path:string,body:Record<string,unknown>){return json(`${api}${path}`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)});}
async function waitFor<T>(label:string,read:()=>Promise<T>,accept:(value:T)=>boolean,timeoutMs=180_000){const end=Date.now()+timeoutMs;let last:T|undefined;while(Date.now()<end){if(child.exitCode!==null)throw new Error(`stack exited ${child.exitCode}: ${output.slice(-2_000)}`);try{last=await read();if(accept(last))return last;}catch{}await sleep(1_000);}throw new Error(`${label} timed out; last=${JSON.stringify(last)}; stack=${output.slice(-2_000)}`);}
const nonce=()=>BigInt(`0x${crypto.randomUUID().replaceAll("-","")}`).toString();
const floorDiv=(value:bigint,divisor:bigint)=>value/divisor-(value<0n&&value%divisor!==0n?1n:0n);
const stressLoss=(btc:bigint,eth:bigint)=>[floorDiv(btc*20n+eth*25n,100n),floorDiv(-btc*20n-eth*25n,100n),floorDiv(btc*15n-eth*20n,100n),floorDiv(-btc*15n+eth*20n,100n),floorDiv(btc*40n+eth*50n,100n),floorDiv(-btc*40n-eth*50n,100n)].reduce((best,value)=>value>best?value:best,0n);
async function makerCapitalPreflight(baseDelta:bigint,executionPrice:bigint){
  const deployment=JSON.parse(readFileSync(resolve(process.env.RFQ_BASE_SEPOLIA_DEPLOYMENT_FILE??".local-state/base-sepolia-deployment.json"),"utf8")) as {contracts:{clearingProxy:string}};
  let lastError:unknown;
  for(const rpcUrl of [independentSecondary,fastPrimary])try{
    const provider=new JsonRpcProvider(rpcUrl,undefined,{batchMaxCount:1}),clearing=new Contract(deployment.contracts.clearingProxy,["function makerBacking() view returns(uint256)","function markets(uint256) view returns(int256 aggregateBase,int256 fundingIndex,uint64 fundingTime,uint64 lastPriceTime,uint256 lastBid,uint256 lastAsk,bool enabled)"],provider),[makerBacking,btc,eth]=await Promise.all([clearing.makerBacking(),clearing.markets(0),clearing.markets(1)]),notional=(state:any)=>BigInt(state.aggregateBase)*(BigInt(state.lastBid)+BigInt(state.lastAsk))/2n/10n**18n,btcNotional=notional(btc),ethNotional=notional(eth)+baseDelta*executionPrice/10n**18n,required=stressLoss(btcNotional,ethNotional)*4n;
    assert(BigInt(makerBacking)>=required,`maker backing preflight failed: ${makerBacking} < ${required} micro-USDC required by the post-trade stress portfolio`);
    return {makerBacking:String(makerBacking),requiredBacking:required.toString(),postTradeExposure:{BTC:btcNotional.toString(),ETH:ethNotional.toString()}};
  }catch(error){lastError=error;}
  throw new Error(`maker capital preflight unavailable on both independent RPCs: ${String(lastError)}`);
}
const priceMoved=(error:unknown)=>String(error).includes("price moved beyond signed protection");
const reservationPending=(error:unknown)=>String(error).includes("outstanding approvals exceed gross, net, stress, side or capital capacity");
const venueSpreadMoved=(error:unknown)=>String(error).includes("venue execution spread rejected");
const staleGrossPrice=(error:unknown)=>String(error).includes("stale_gross_price");
const approverPolicyMoved=(error:unknown)=>String(error).includes("policy rejected");
const approverQuorumTimedOut=(error:unknown)=>String(error).includes("approver quorum unavailable")&&String(error).includes("TimeoutError");
const hedgeRiskUnavailable=(error:unknown)=>String(error).includes("hedge risk requires exposure reduction");
const requestTimedOut=(error:unknown)=>String(error).includes("TimeoutError");
const approvalRiskChanged=(error:unknown)=>String(error).includes("approval risk changed; request a fresh quote");
const chainSubmissionFailed=(error:unknown)=>String(error).includes('"error":"chain submission failed"');
// Approvers retain a conservative gross reservation until the signed approval
// deadline (at most 30 seconds). A mixed quorum failure can therefore reserve
// capacity even when the API returns an error. Let that reservation finalize
// before preparing a new intent, otherwise retries can continually replace one
// expiring reservation with another and never recover.
const retryDelay=(error:unknown)=>reservationPending(error)||venueSpreadMoved(error)||staleGrossPrice(error)||approverPolicyMoved(error)||approverQuorumTimedOut(error)||hedgeRiskUnavailable(error)||requestTimedOut(error)||approvalRiskChanged(error)||chainSubmissionFailed(error)?40_000:priceMoved(error)?250:null;
async function closeEth(){let last:unknown;for(let attempt=1;attempt<=12;attempt++)try{const quote=await waitFor("fresh close quote",()=>post("/v1/close/quote",{account:wallet.address,market:"ETH"}),value=>Date.now()-Number(value.observedAtMs)<=4_500,30_000),closeNonce=nonce(),prepared=await post("/v1/prepare",{quoteId:quote.quoteId,account:wallet.address,nonce:closeNonce,reduceOnly:true}),signature=await wallet.signTypedData(prepared.domain,prepared.types,prepared.intent);return await post("/v1/approve",{quoteId:quote.quoteId,account:wallet.address,nonce:closeNonce,reduceOnly:true,userSignature:signature});}catch(error){last=error;const delay=retryDelay(error);if(delay===null||attempt===12)throw error;await sleep(delay);}throw last;}
async function openEth(){let last:unknown;for(let attempt=1;attempt<=12;attempt++)try{const quote=await waitFor("fresh firm quote",()=>post("/v1/quote",{market:"ETH",side:"buy",amount:"11.5"}),value=>Date.now()-Number(value.observedAtMs)<=4_500,30_000);console.log(JSON.stringify({quoteAttempt:attempt,quoteObservedAtMs:Number(quote.observedAtMs),quoteAgeMs:Date.now()-Number(quote.observedAtMs)}));const tradeNonce=nonce(),prepared=await post("/v1/prepare",{quoteId:quote.quoteId,account:wallet.address,nonce:tradeNonce}),capital=await makerCapitalPreflight(BigInt(prepared.intent.baseDelta),BigInt(quote.expectedPrice));console.log(JSON.stringify({makerCapitalPreflight:capital}));const signature=await wallet.signTypedData(prepared.domain,prepared.types,prepared.intent),approvalStarted=Date.now();try{const execution=await post("/v1/approve",{quoteId:quote.quoteId,account:wallet.address,nonce:tradeNonce,userSignature:signature});console.log(JSON.stringify({approvalToInclusionMs:Date.now()-approvalStarted}));return execution;}catch(error){console.log(JSON.stringify({approvalFailureAfterMs:Date.now()-approvalStarted,error:String(error).slice(-1_000)}));throw error;}}catch(error){last=error;const delay=retryDelay(error);if(delay===null||attempt===12)throw error;await sleep(delay);if(chainSubmissionFailed(error)){const account=await json(`${api}/v1/account/${wallet.address}`) as Account;if(account.positions.ETH.size!=="0"){await closeEth();await waitFlat();}}}throw last;}
async function waitFlat(){await waitFor("finalized customer and venue flatten",()=>json(hedger+"/v1/status") as Promise<HedgeStatus>,status=>status.healthy&&status.markets.ETH.customerBase==="0"&&status.positions.ETH==="0");}
async function stop(process:ChildProcess){if(process.exitCode!==null)return;process.kill("SIGTERM");await Promise.race([new Promise<void>(resolve=>process.once("exit",()=>resolve())),sleep(8_000).then(()=>{if(process.exitCode===null)process.kill("SIGKILL");})]);}

try{
  await waitFor("stack readiness",()=>json(api+"/health"),()=>output.includes("services ready"),180_000);
  await waitFor("healthy hedge loop",()=>json(hedger+"/v1/status") as Promise<HedgeStatus>,status=>status.healthy&&status.markets.ETH.customerBase!==undefined);
  await waitFor("normal ETH hedge risk",()=>json(hedger+"/internal/risk") as Promise<HedgeRisk>,risk=>risk.healthy&&risk.markets.ETH.mode==="normal");
  const initial=await json(`${api}/v1/account/${wallet.address}`) as Account,initialHedge=await json(hedger+"/v1/status") as HedgeStatus;
  console.log(JSON.stringify({initial:{accountEth:initial.positions.ETH.size,customerEth:initialHedge.markets.ETH.customerBase,venueEth:initialHedge.positions.ETH,gapNotional:initialHedge.markets.ETH.gapNotional}}));
  if(initial.positions.ETH.size!=="0")await closeEth();
  if(initial.positions.ETH.size!=="0"||initialHedge.positions.ETH!=="0")await waitFlat();

  const started=Date.now(),execution=await openEth();
  assert.match(execution.transaction.hash,/^0x[0-9a-f]{64}$/i);
  const opened=await waitFor("finalized customer exposure and venue hedge",()=>json(hedger+"/v1/status") as Promise<HedgeStatus>,status=>status.healthy&&BigInt(status.markets.ETH.customerBase)>0n&&BigInt(status.positions.ETH)>0n);
  const openingOrders=opened.orders.filter(order=>order.market==="ETH"&&order.status==="filled"&&BigInt(order.base_delta)>0n&&order.reason===null);
  assert(openingOrders.length>0,"no filled opening hedge was journaled");

  const close=await closeEth();assert.match(close.transaction.hash,/^0x[0-9a-f]{64}$/i);
  const flat=await waitFor("finalized close and venue unwind",()=>json(hedger+"/v1/status") as Promise<HedgeStatus>,status=>status.healthy&&status.markets.ETH.customerBase==="0"&&status.positions.ETH==="0");
  assert.equal(flat.markets.BTC.customerBase,"0","BTC customer exposure remains after cycle");
  assert.equal(flat.positions.BTC,"0","BTC venue exposure remains after cycle");
  const orders=flat.orders.filter(order=>order.market==="ETH"&&order.created_ms>=started);
  const closingOrders=orders.filter(order=>order.status==="filled"&&BigInt(order.base_delta)<0n&&order.reason===null);
  assert(closingOrders.length>0,"no filled closing hedge was journaled");assert.equal(new Set(orders.map(order=>order.client_id)).size,orders.length,"duplicate hedge client IDs");assert(orders.every(order=>order.venue_order_id),"a hedge lacks a venue order ID");
  const indexed=await waitFor("indexed flat account",()=>json(`${indexer}/v1/account/${wallet.address}`) as Promise<Account>,account=>account.positions.ETH.size==="0");assert.equal(indexed.positions.ETH.size,"0");
  console.log(JSON.stringify({verified:true,market:"ETH",customerNotionalUsdc:"11.5",tradeTransaction:execution.transaction.hash,closeTransaction:close.transaction.hash,openingHedgeOrders:openingOrders.map(order=>({clientId:order.client_id,venueOrderId:order.venue_order_id,filledBase:order.filled_base})),closingHedgeOrders:closingOrders.map(order=>({clientId:order.client_id,venueOrderId:order.venue_order_id,filledBase:order.filled_base})),finalCustomerBase:flat.markets.ETH.customerBase,finalVenueBase:flat.positions.ETH,finalBtcCustomerBase:flat.markets.BTC.customerBase,finalBtcVenueBase:flat.positions.BTC},null,2));
}finally{
  try{const account=await json(`${api}/v1/account/${wallet.address}`) as Account;if(account.positions.ETH.size!=="0"){await closeEth();await waitFlat();}}catch(error){console.error(`cleanup warning: ${String(error)}`);}
  await stop(child);
  rmSync(runtime,{recursive:true,force:true});
}
