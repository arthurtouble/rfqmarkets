import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AbiCoder, Wallet, keccak256 } from "ethers";
import { buildApprover } from "../../approver/src/server.js";
import { buildApi } from "./server.js";

const directory = mkdtempSync(join(tmpdir(), "rfq-services-"));
const chainId=31_337n;
const verifyingContract="0x0000000000000000000000000000000000000001";
const apps: Array<ReturnType<typeof buildApprover>> = [];
let api: ReturnType<typeof buildApi>;
let routedFetch: typeof fetch;
const user = Wallet.createRandom();

async function approveQuote(target:ReturnType<typeof buildApi>,quote:{quoteId:string},signer=user) {
  const nonce=BigInt(`0x${crypto.randomUUID().replaceAll("-","")}`).toString();
  const preparedResponse=await target.inject({method:"POST",url:"/v1/prepare",payload:{quoteId:quote.quoteId,account:signer.address,nonce}});
  assert.equal(preparedResponse.statusCode,200,preparedResponse.body);
  const prepared=preparedResponse.json();
  const signature=await signer.signTypedData(prepared.domain,prepared.types,prepared.intent);
  return target.inject({method:"POST",url:"/v1/approve",payload:{quoteId:quote.quoteId,account:signer.address,nonce,userSignature:signature}});
}

before(async () => {
  const approvers = [];
  for (let index = 0; index < 3; index++) {
    const token = `transport-${index}`;
    const app = buildApprover({ privateKey: Wallet.createRandom().privateKey, transportToken: token, databasePath: join(directory, `${index}.sqlite`),expectedChainId:chainId,expectedVerifyingContract:verifyingContract });
    apps.push(app);
    await app.ready();
    approvers.push({ url:`http://approver-${index}`, token });
  }
  routedFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input.toString() : input.url);
    const index = Number(url.hostname.split("-")[1]);
    if (!Number.isInteger(index) || !apps[index]) throw new Error("approver offline");
    const response = await apps[index].inject({
      method:(init?.method ?? "GET") as "GET"|"POST",
      url:url.pathname,
      headers:init?.headers as Record<string,string>,
      payload:typeof init?.body === "string" ? init.body : undefined,
    });
    return new Response(response.body, { status:response.statusCode, headers:response.headers as HeadersInit });
  }) as typeof fetch;
  api = buildApi({ approvers, fetchImpl:routedFetch });
  await api.ready();
});

after(async () => {
  await api.close();
  await Promise.all(apps.map((app) => app.close()));
  rmSync(directory, { recursive:true, force:true });
});

test("two distinct approvers sign and same-direction reservations worsen the next quote", async () => {
  const firstResponse = await api.inject({ method:"POST", url:"/v1/quote", payload:{market:"BTC",side:"buy",amount:"10000"} });
  assert.equal(firstResponse.statusCode, 200);
  const first = firstResponse.json();
  const reservation = await approveQuote(api,first);
  assert.equal(reservation.statusCode, 200, reservation.body);
  const approved = reservation.json();
  assert.equal(new Set(approved.approvals.map((item:{signer:string}) => item.signer.toLowerCase())).size, 2);
  const secondResponse = await api.inject({ method:"POST", url:"/v1/quote", payload:{market:"BTC",side:"buy",amount:"10000"} });
  const second = secondResponse.json();
  assert(BigInt(second.expectedPrice) > BigInt(first.expectedPrice));
});

test("one unavailable approver still leaves quorum", async () => {
  const healthy = apps.slice(0,2).map((_,index) => ({ url:`http://approver-${index}`, token:`transport-${index}` }));
  const degraded = buildApi({ approvers:[...healthy,{url:"http://approver-99",token:"offline"}], fetchImpl:routedFetch });
  await degraded.ready();
  const quote = (await degraded.inject({method:"POST",url:"/v1/quote",payload:{market:"ETH",side:"sell",amount:"500"}})).json();
  const result = await approveQuote(degraded,quote);
  assert.equal(result.statusCode, 200, result.body);
  await degraded.close();
});

test("duplicate signed submissions share one approver quorum request",async()=>{
  let calls=0;const delayedFetch=(async(input:Parameters<typeof fetch>[0],init?:Parameters<typeof fetch>[1])=>{calls++;await new Promise(resolve=>setTimeout(resolve,20));return routedFetch(input,init);}) as typeof fetch;
  const target=buildApi({approvers:apps.map((_,index)=>({url:`http://approver-${index}`,token:`transport-${index}`})),fetchImpl:delayedFetch});await target.ready();
  const quote=(await target.inject({method:"POST",url:"/v1/quote",payload:{market:"BTC",side:"buy",amount:"100"}})).json(),nonce="424242",prepared=(await target.inject({method:"POST",url:"/v1/prepare",payload:{quoteId:quote.quoteId,account:user.address,nonce}})).json(),userSignature=await user.signTypedData(prepared.domain,prepared.types,prepared.intent),payload={quoteId:quote.quoteId,account:user.address,nonce,userSignature};
  const [first,second]=await Promise.all([target.inject({method:"POST",url:"/v1/approve",payload}),target.inject({method:"POST",url:"/v1/approve",payload})]);assert.equal(first.statusCode,200,first.body);assert.equal(second.statusCode,200,second.body);assert.equal(calls,3,"duplicate submission multiplied signer work");await target.close();
});

test("real oracle source drives quotes and fails closed when unavailable",async()=>{
  const now=Math.floor(Date.now()/1_000),oracleApi=buildApi({oracleSource:{latest:async market=>({snapshot:{market,bid:market==="BTC"?89_990n*1_000_000n:2_990n*1_000_000n,ask:market==="BTC"?90_010n*1_000_000n:3_010n*1_000_000n,observedAtMs:Date.now()},report:"0x1234",validUntil:now+10})}});await oracleApi.ready();
  const response=await oracleApi.inject({method:"POST",url:"/v1/quote",payload:{market:"BTC",side:"buy",amount:"100"}});assert.equal(response.statusCode,200,response.body);const quote=response.json();assert(BigInt(quote.expectedPrice)>89_990n*1_000_000n);assert(Number(quote.expiresAtMs)<=((now+10)*1_000));await oracleApi.close();
  const failed=buildApi({oracleSource:{latest:async()=>{throw new Error("feed unavailable")}}});await failed.ready();const unavailable=await failed.inject({method:"POST",url:"/v1/quote",payload:{market:"BTC",side:"buy",amount:"100"}});assert.equal(unavailable.statusCode,503);await failed.close();
});

test("refreshes the authenticated settlement proof after wallet signing",async()=>{
  const now=Math.floor(Date.now()/1_000);let settlements=0;
  const observation=(bid:bigint,ask:bigint,reportTag:string)=>({snapshot:{market:"BTC" as const,bid,ask,observedAtMs:Date.now()},report:AbiCoder.defaultAbiCoder().encode(["tuple(uint8 market,uint256 bid,uint256 ask,uint64 observedAt,uint64 validUntil)"],[[0,bid,ask,now,now+15]]),validUntil:now+15,reportTag});
  const target=buildApi({approvers:apps.map((_,index)=>({url:`http://approver-${index}`,token:`transport-${index}`})),fetchImpl:routedFetch,oracleSource:{
    latest:async()=>observation(99_990n*1_000_000n,100_010n*1_000_000n,"indicative"),
    settlement:async()=>{settlements++;return settlements===1?observation(99_990n*1_000_000n,100_010n*1_000_000n,"initial"):observation(99_995n*1_000_000n,100_015n*1_000_000n,"refreshed");},
  }});await target.ready();
  const quote=(await target.inject({method:"POST",url:"/v1/quote",payload:{market:"BTC",side:"buy",amount:"100"}})).json(),nonce="991",prepared=(await target.inject({method:"POST",url:"/v1/prepare",payload:{quoteId:quote.quoteId,account:user.address,nonce}})).json();
  assert(Number(prepared.intent.deadline)>now+10,"user intent must not inherit the first oracle proof expiry");
  const userSignature=await user.signTypedData(prepared.domain,prepared.types,prepared.intent),response=await target.inject({method:"POST",url:"/v1/approve",payload:{quoteId:quote.quoteId,account:user.address,nonce,userSignature}});assert.equal(response.statusCode,200,response.body);
  const approved=response.json(),expectedReport=observation(99_995n*1_000_000n,100_015n*1_000_000n,"refreshed").report;assert.equal(settlements,2);assert.equal(approved.approval.oracleReportHash,keccak256(expectedReport));assert(BigInt(approved.quote.expectedPrice)>BigInt(quote.expectedPrice));await target.close();
});

test("rejects a refreshed settlement price outside the signed protection",async()=>{
  const now=Math.floor(Date.now()/1_000);let settlements=0;const observation=(bid:bigint,ask:bigint)=>({snapshot:{market:"BTC" as const,bid,ask,observedAtMs:Date.now()},report:AbiCoder.defaultAbiCoder().encode(["tuple(uint8 market,uint256 bid,uint256 ask,uint64 observedAt,uint64 validUntil)"],[[0,bid,ask,now,now+15]]),validUntil:now+15}),target=buildApi({oracleSource:{
    latest:async()=>observation(99_990n*1_000_000n,100_010n*1_000_000n),
    settlement:async()=>{settlements++;return settlements===1?observation(99_990n*1_000_000n,100_010n*1_000_000n):observation(100_990n*1_000_000n,101_010n*1_000_000n);},
  }});await target.ready();
  const quote=(await target.inject({method:"POST",url:"/v1/quote",payload:{market:"BTC",side:"buy",amount:"100"}})).json(),nonce="992",prepared=(await target.inject({method:"POST",url:"/v1/prepare",payload:{quoteId:quote.quoteId,account:user.address,nonce}})).json(),userSignature=await user.signTypedData(prepared.domain,prepared.types,prepared.intent),response=await target.inject({method:"POST",url:"/v1/approve",payload:{quoteId:quote.quoteId,account:user.address,nonce,userSignature}});assert.equal(response.statusCode,409,response.body);assert.match(response.json().error,/signed protection/);await target.close();
});

test("development funding cannot expose a wallet on a non-local chain",()=>{
  assert.throws(()=>buildApi({chainId:8453n,chain:{rpcUrl:"https://mainnet.base.org",sponsorPrivateKey:Wallet.createRandom().privateKey,clearingAddress:"0x0000000000000000000000000000000000000001",tokenAddress:"0x0000000000000000000000000000000000000002",devFund:true,devWallet:{account:Wallet.createRandom().address,privateKey:Wallet.createRandom().privateKey}}}),/development funding requires local chain/);
});

test("market snapshots expose bid, ask, mid and signed funding without a chain",async()=>{
  const marketApi=buildApi();await marketApi.ready();
  const response=await marketApi.inject({method:"GET",url:"/v1/markets"});assert.equal(response.statusCode,200,response.body);
  const snapshot=response.json();assert.equal(snapshot.markets.BTC.mid,"100000000000");assert.equal(snapshot.markets.BTC.bid,"99990000000");assert.equal(snapshot.markets.BTC.ask,"100010000000");assert.equal(snapshot.markets.BTC.fundingApr,"0");assert.equal(snapshot.markets.ETH.enabled,true);
  assert.deepEqual(snapshot.pricing.settled,{BTC:"0",ETH:"0"});assert.deepEqual(snapshot.pricing.pending,[]);assert.equal(snapshot.markets.BTC.maxTradeNotional,"1000000000000");assert.equal(snapshot.markets.BTC.maxMarketNotional,"5000000000000");
  await marketApi.close();
});

test("hedge monitor failure fails firm quotes closed and exposes reduce-only market state",async()=>{
  const hedgeRiskSource={latest:async()=>{throw new Error("hedger offline")}},marketApi=buildApi({hedgeRiskSource});await marketApi.ready();
  const markets=(await marketApi.inject({method:"GET",url:"/v1/markets"})).json();assert.equal(markets.markets.BTC.riskMode,"reduce_only");assert.equal(markets.markets.BTC.canBuy,false);assert.equal(markets.markets.BTC.canSell,false);
  const quote=await marketApi.inject({method:"POST",url:"/v1/quote",payload:{market:"BTC",side:"buy",amount:"100"}});assert.equal(quote.statusCode,503);assert.match(quote.body,/exposure-reducing/);await marketApi.close();
});

test("firm quote and unsigned order preparation have bounded admission",async()=>{
  const bounded=buildApi({maxActiveQuotes:1,maxRestingOrders:1});await bounded.ready();
  assert.equal((await bounded.inject({method:"POST",url:"/v1/quote",payload:{market:"BTC",side:"buy",amount:"100"}})).statusCode,200);
  const full=await bounded.inject({method:"POST",url:"/v1/quote",payload:{market:"BTC",side:"buy",amount:"101"}});assert.equal(full.statusCode,409);assert.match(full.body,/capacity/);
  const payload={account:user.address,market:"ETH",side:"buy",amount:"100",limitPrice:"2000",durationSeconds:3600,nonce:"991",reduceOnly:false};assert.equal((await bounded.inject({method:"POST",url:"/v1/orders/prepare",payload})).statusCode,200);
  const orderFull=await bounded.inject({method:"POST",url:"/v1/orders/prepare",payload:{...payload,nonce:"992"}});assert.equal(orderFull.statusCode,409);assert.match(orderFull.body,/capacity/);await bounded.close();
});

test("a durable all-or-none limit order binds size, price, fee, nonce and expiry",async()=>{
  const orderApi=buildApi();await orderApi.ready();const nonce="998877";
  const preparedResponse=await orderApi.inject({method:"POST",url:"/v1/orders/prepare",payload:{account:user.address,market:"BTC",side:"buy",amount:"1000",limitPrice:"90000",durationSeconds:3600,nonce,reduceOnly:false}});assert.equal(preparedResponse.statusCode,200,preparedResponse.body);
  const prepared=preparedResponse.json();assert.equal(prepared.intent.leaderEpoch,undefined);assert.equal(prepared.intent.policyVersion,undefined);assert.equal(prepared.intent.limitPrice,"90000000000");assert.equal(prepared.intent.nonce,nonce);
  const attacker=Wallet.createRandom(),badSignature=await attacker.signTypedData(prepared.domain,prepared.types,prepared.intent);
  assert.equal((await orderApi.inject({method:"POST",url:"/v1/orders",payload:{orderId:prepared.orderId,userSignature:badSignature}})).statusCode,401);
  const signature=await user.signTypedData(prepared.domain,prepared.types,prepared.intent),placed=await orderApi.inject({method:"POST",url:"/v1/orders",payload:{orderId:prepared.orderId,userSignature:signature}});assert.equal(placed.statusCode,200,placed.body);
  const list=(await orderApi.inject({method:"GET",url:`/v1/orders/${user.address}`})).json();assert.equal(list.items.length,1);assert.equal(list.items[0].status,"open");assert.equal(list.items[0].limitPrice,"90000000000");
  await orderApi.close();
});

test("an open limit order survives API restart without becoming a balance ledger",async()=>{
  const journalPath=join(directory,"orders-restart.sqlite"),first=buildApi({journalPath});await first.ready();
  const prepared=(await first.inject({method:"POST",url:"/v1/orders/prepare",payload:{account:user.address,market:"ETH",side:"sell",amount:"750",limitPrice:"5000",durationSeconds:3600,nonce:"123123",reduceOnly:false}})).json(),signature=await user.signTypedData(prepared.domain,prepared.types,prepared.intent);
  assert.equal((await first.inject({method:"POST",url:"/v1/orders",payload:{orderId:prepared.orderId,userSignature:signature}})).statusCode,200);await first.close();
  const restarted=buildApi({journalPath});await restarted.ready();const list=(await restarted.inject({method:"GET",url:`/v1/orders/${user.address}`})).json();assert.equal(list.items.length,1);assert.equal(list.items[0].orderId,prepared.orderId);assert.equal(list.items[0].status,"open");await restarted.close();
});

test("an invalid wallet signature cannot reserve portfolio capacity",async()=>{
  const first=(await api.inject({method:"POST",url:"/v1/quote",payload:{market:"ETH",side:"buy",amount:"777"}})).json();
  const nonce="7";
  const prepared=(await api.inject({method:"POST",url:"/v1/prepare",payload:{quoteId:first.quoteId,account:user.address,nonce}})).json();
  const attacker=Wallet.createRandom();
  const badSignature=await attacker.signTypedData(prepared.domain,prepared.types,prepared.intent);
  const rejected=await api.inject({method:"POST",url:"/v1/approve",payload:{quoteId:first.quoteId,account:user.address,nonce,userSignature:badSignature}});
  assert.equal(rejected.statusCode,401);
  const second=(await api.inject({method:"POST",url:"/v1/quote",payload:{market:"ETH",side:"buy",amount:"777"}})).json();
  assert.equal(second.expectedPrice,first.expectedPrice);
});

test("a prepared quote cannot be reused by another wallet or nonce",async()=>{
  const quote=(await api.inject({method:"POST",url:"/v1/quote",payload:{market:"BTC",side:"buy",amount:"333"}})).json();
  const nonce="123456";
  const first=await api.inject({method:"POST",url:"/v1/prepare",payload:{quoteId:quote.quoteId,account:user.address,nonce}});
  assert.equal(first.statusCode,200,first.body);
  const retry=await api.inject({method:"POST",url:"/v1/prepare",payload:{quoteId:quote.quoteId,account:user.address,nonce}});
  assert.equal(retry.statusCode,200,retry.body);
  const attacker=Wallet.createRandom();
  const otherWallet=await api.inject({method:"POST",url:"/v1/prepare",payload:{quoteId:quote.quoteId,account:attacker.address,nonce}});
  assert.equal(otherWallet.statusCode,409);
  const otherNonce=await api.inject({method:"POST",url:"/v1/prepare",payload:{quoteId:quote.quoteId,account:user.address,nonce:"123457"}});
  assert.equal(otherNonce.statusCode,409);
});

test("market intents bind reduce-only and cannot be re-prepared with weaker semantics",async()=>{
  const target=buildApi({approvers:apps.map((_,index)=>({url:`http://approver-${index}`,token:`transport-${index}`})),fetchImpl:routedFetch});await target.ready();const quote=(await target.inject({method:"POST",url:"/v1/quote",payload:{market:"ETH",side:"sell",amount:"200"}})).json(),nonce="771122";
  const first=await target.inject({method:"POST",url:"/v1/prepare",payload:{quoteId:quote.quoteId,account:user.address,nonce,reduceOnly:true}});assert.equal(first.statusCode,200,first.body);assert.equal(first.json().intent.reduceOnly,true);
  const second=await target.inject({method:"POST",url:"/v1/prepare",payload:{quoteId:quote.quoteId,account:user.address,nonce,reduceOnly:false}});assert.equal(second.statusCode,200,second.body);assert.equal(second.json().intent.reduceOnly,true,"the first prepared intent must remain authoritative");
  const signature=await user.signTypedData(first.json().domain,first.json().types,first.json().intent),approved=await target.inject({method:"POST",url:"/v1/approve",payload:{quoteId:quote.quoteId,account:user.address,nonce,userSignature:signature,reduceOnly:false}});assert.equal(approved.statusCode,200,approved.body);assert.equal(approved.json().intent.reduceOnly,true,"approval must use the signed prepared intent");await target.close();
});

test("approvers reject an API that requests signatures for an unpinned chain domain",async()=>{
  const approvers=apps.map((_,index)=>({url:`http://approver-${index}`,token:`transport-${index}`}));
  const wrongDomain=buildApi({approvers,fetchImpl:routedFetch,chainId:1n,verifyingContract});
  await wrongDomain.ready();
  const quote=(await wrongDomain.inject({method:"POST",url:"/v1/quote",payload:{market:"BTC",side:"sell",amount:"250"}})).json();
  const result=await approveQuote(wrongDomain,quote);
  assert.equal(result.statusCode,503);
  await wrongDomain.close();
});

test("a restart restores escaped reservation exposure from the API journal",async()=>{
  const approvers=apps.map((_,index)=>({url:`http://approver-${index}`,token:`transport-${index}`}));
  const journalPath=join(directory,"api.sqlite");
  const firstApi=buildApi({approvers,fetchImpl:routedFetch,journalPath}); await firstApi.ready();
  const first=(await firstApi.inject({method:"POST",url:"/v1/quote",payload:{market:"BTC",side:"buy",amount:"900"}})).json();
  assert.equal((await approveQuote(firstApi,first)).statusCode,200); await firstApi.close();
  const restarted=buildApi({approvers,fetchImpl:routedFetch,journalPath}); await restarted.ready();
  const after=(await restarted.inject({method:"POST",url:"/v1/quote",payload:{market:"BTC",side:"buy",amount:"900"}})).json();
  assert(BigInt(after.expectedPrice)>BigInt(first.expectedPrice)); await restarted.close();
});

test("deposit routes bind source terms and require the receiving wallet",async()=>{
  const routeResponse=await api.inject({method:"POST",url:"/v1/deposit/quote",payload:{account:user.address,fromChainId:1,fromToken:"ETH",amount:"1"}});
  assert.equal(routeResponse.statusCode,200,routeResponse.body);const route=routeResponse.json();
  const attacker=Wallet.createRandom();const bad=await attacker.signTypedData(route.domain,route.types,route.intent);
  assert.equal((await api.inject({method:"POST",url:"/v1/deposit/execute",payload:{routeId:route.routeId,userSignature:bad}})).statusCode,401);
  const signature=await user.signTypedData(route.domain,route.types,route.intent);
  const unavailable=await api.inject({method:"POST",url:"/v1/deposit/execute",payload:{routeId:route.routeId,userSignature:signature}});
  assert.equal(unavailable.statusCode,503);
});

test("an unexpired deposit authorization survives an API leader restart",async()=>{
  const journalPath=join(directory,"deposit-restart.sqlite");
  const firstApi=buildApi({journalPath});await firstApi.ready();
  const response=await firstApi.inject({method:"POST",url:"/v1/deposit/quote",payload:{account:user.address,fromChainId:42161,fromToken:"USDC",amount:"250"}});
  assert.equal(response.statusCode,200,response.body);const route=response.json();await firstApi.close();
  const restarted=buildApi({journalPath});await restarted.ready();
  const signature=await user.signTypedData(route.domain,route.types,route.intent);
  const result=await restarted.inject({method:"POST",url:"/v1/deposit/execute",payload:{routeId:route.routeId,userSignature:signature}});
  assert.equal(result.statusCode,503,result.body);await restarted.close();
});

test("owner exit and cancellation actions are exactly signed before sponsorship",async()=>{
  const nonce=BigInt(`0x${crypto.randomUUID().replaceAll("-","")}`).toString();
  const withdrawal=(await api.inject({method:"POST",url:"/v1/withdraw/prepare",payload:{account:user.address,amount:"25.5",nonce}})).json();
  assert.equal(withdrawal.intent.recipient,user.address);assert.equal(withdrawal.intent.amount,"25500000");
  const withdrawalSignature=await user.signTypedData(withdrawal.domain,withdrawal.types,withdrawal.intent);
  assert.equal((await api.inject({method:"POST",url:"/v1/withdraw/execute",payload:{intent:withdrawal.intent,userSignature:withdrawalSignature}})).statusCode,503);
  const attacker=Wallet.createRandom(),badWithdrawal=await attacker.signTypedData(withdrawal.domain,withdrawal.types,withdrawal.intent);
  assert.equal((await api.inject({method:"POST",url:"/v1/withdraw/execute",payload:{intent:withdrawal.intent,userSignature:badWithdrawal}})).statusCode,401);

  const cancel=(await api.inject({method:"POST",url:"/v1/nonce/cancel/prepare",payload:{account:user.address,nonce:(BigInt(nonce)+1n).toString()}})).json();
  const cancelSignature=await user.signTypedData(cancel.domain,cancel.types,cancel.intent);
  assert.equal((await api.inject({method:"POST",url:"/v1/nonce/cancel/execute",payload:{intent:cancel.intent,userSignature:cancelSignature}})).statusCode,503);

  const close=(await api.inject({method:"POST",url:"/v1/close/prepare",payload:{account:user.address,market:"BTC",nonce:(BigInt(nonce)+2n).toString()}})).json();
  const closeSignature=await user.signTypedData(close.domain,close.types,close.intent);
  assert.equal((await api.inject({method:"POST",url:"/v1/close/execute",payload:{intent:close.intent,userSignature:closeSignature}})).statusCode,503);

  const session=Wallet.createRandom();
  const grantResponse=await api.inject({method:"POST",url:"/v1/session/prepare",payload:{account:user.address,session:session.address,marketMask:3,maxTradeAmount:"2500",maxCumulativeAmount:"10000",maxFee:"5",durationSeconds:28_800,nonce:(BigInt(nonce)+3n).toString()}});
  assert.equal(grantResponse.statusCode,200,grantResponse.body);const grant=grantResponse.json();
  const grantSignature=await user.signTypedData(grant.domain,grant.types,grant.grant);
  assert.equal((await api.inject({method:"POST",url:"/v1/session/execute",payload:{grant:grant.grant,userSignature:grantSignature}})).statusCode,503);
});
