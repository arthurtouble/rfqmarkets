import assert from "node:assert/strict";
import { Wallet } from "ethers";

const api=process.env.RFQ_API_URL??"http://127.0.0.1:4100",user=Wallet.createRandom();
const post=async(path:string,body:unknown)=>{const response=await fetch(`${api}${path}`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)}),payload=await response.json();assert(response.ok,`${path}: ${JSON.stringify(payload)}`);return payload;};
const nonce=()=>BigInt(`0x${crypto.randomUUID().replaceAll("-","")}`).toString();

const route=await post("/v1/deposit/quote",{account:user.address,fromChainId:1,fromToken:"USDC",amount:"5000"}),depositSignature=await user.signTypedData(route.domain,route.types,route.intent);
await post("/v1/deposit/execute",{routeId:route.routeId,userSignature:depositSignature});
const prepared=await post("/v1/orders/prepare",{account:user.address,market:"BTC",side:"buy",amount:"1000",limitPrice:"101000",durationSeconds:3600,nonce:nonce(),reduceOnly:false});
assert.equal(prepared.intent.leaderEpoch,undefined);assert.equal(prepared.intent.policyVersion,undefined);
const orderSignature=await user.signTypedData(prepared.domain,prepared.types,prepared.intent);await post("/v1/orders",{orderId:prepared.orderId,userSignature:orderSignature});
let order:any;
for(let attempt=0;attempt<80;attempt++){const response=await fetch(`${api}/v1/orders/${user.address}`),body=await response.json();order=body.items.find((item:any)=>item.orderId===prepared.orderId);if(order?.status==="filled")break;await new Promise(resolve=>setTimeout(resolve,100));}
assert.equal(order?.status,"filled",JSON.stringify(order));assert.match(order.transactionHash,/^0x[0-9a-fA-F]{64}$/);
const account=await fetch(`${api}/v1/account/${user.address}`).then(response=>response.json());assert(BigInt(account.positions.BTC.size)>0n);assert(BigInt(account.grossNotional)>0n);
const marketsResponse=await fetch(`${api}/v1/markets`);assert(marketsResponse.ok);const markets=await marketsResponse.json(),nonMarketableLimit=(Number(BigInt(markets.markets.ETH.bid))/2e6).toFixed(2);
const cancelPrepared=await post("/v1/orders/prepare",{account:user.address,market:"ETH",side:"buy",amount:"500",limitPrice:nonMarketableLimit,durationSeconds:3600,nonce:nonce(),reduceOnly:false}),cancelOrderSignature=await user.signTypedData(cancelPrepared.domain,cancelPrepared.types,cancelPrepared.intent);await post("/v1/orders",{orderId:cancelPrepared.orderId,userSignature:cancelOrderSignature});
const cancellation=await post(`/v1/orders/${cancelPrepared.orderId}/cancel/prepare`,{}),cancelSignature=await user.signTypedData(cancellation.domain,cancellation.types,cancellation.intent),cancelled=await post(`/v1/orders/${cancelPrepared.orderId}/cancel`,{intent:cancellation.intent,userSignature:cancelSignature});assert.equal(cancelled.status,"cancelled");
console.log(`Limit-order smoke passed: ${prepared.orderId} settled and ${cancelPrepared.orderId} cancelled on-chain`);
