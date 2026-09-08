import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Wallet } from "ethers";
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
