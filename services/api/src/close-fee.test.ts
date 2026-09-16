import assert from "node:assert/strict";
import {test} from "node:test";
import {Interface,JsonRpcProvider,Wallet,type TransactionRequest} from "ethers";
import {clearingApiAbi} from "../../../packages/shared/src/abi.js";
import {buildApi} from "./server.js";
import {closeTypes,DOMAIN_NAME,DOMAIN_VERSION} from "../../../packages/shared/src/eip712.js";

test("sponsored paused close simulates and forwards a nonzero proof verification fee",async()=>{
  const clearing="0x0000000000000000000000000000000000000001",oracle="0x0000000000000000000000000000000000000002",iface=new Interface(clearingApiAbi),adapter=new Interface(["function updateFee(bytes) view returns(uint256)"]),user=Wallet.createRandom(),now=Math.floor(Date.now()/1000);let simulated=false,submitted=false;
  class Chain extends JsonRpcProvider{
    override async send(method:string){if(method==="eth_getTransactionReceipt"){const event=iface.encodeEventLog(iface.getEvent("PositionClosed")!,[user.address,0,-1n,1n]);return {status:"0x1",logs:[{address:clearing,...event}]};}throw new Error(`unexpected ${method}`);}
  override async call(request:TransactionRequest){
      if(request.to===oracle)return adapter.encodeFunctionResult("updateFee",[7n]);
      const parsed=iface.parseTransaction({data:String(request.data)})!;
      if(parsed.name==="oracle")return iface.encodeFunctionResult("oracle",[oracle]);
      if(parsed.name==="positionOf")return iface.encodeFunctionResult("positionOf",[0n,0n,0n]);
      assert.equal(parsed.name,"closePositionWithSignature");assert.equal(request.value,7n);simulated=true;return "0x";
    }
  }
  const provider=new Chain(),app=buildApi({provider,chainId:84532n,verifyingContract:clearing,chain:{rpcUrl:"https://unused",sponsorPrivateKey:Wallet.createRandom().privateKey,clearingAddress:clearing,tokenAddress:oracle},oracleSource:{latest:async()=>({snapshot:{market:"BTC",bid:1n,ask:1n,observedAtMs:Date.now()},report:"0x1234",validUntil:now+15})},sender:{reconcile:async()=>{},status:()=>[],submit:async(_id,request)=>{assert.equal(simulated,true);assert.equal(request.value,7n);submitted=true;return {hash:"0x"+"11".repeat(32),blockHash:"0x"+"22".repeat(32),blockNumber:1,status:1};}}});
  try{
    await app.ready();const intent={account:user.address,market:0,nonce:1n,deadline:BigInt(now+120)},signature=await user.signTypedData({name:DOMAIN_NAME,version:DOMAIN_VERSION,chainId:84532n,verifyingContract:clearing},closeTypes,intent);
    const response=await app.inject({method:"POST",url:"/v1/close/execute",payload:{intent:{...intent,nonce:"1",deadline:String(intent.deadline)},userSignature:signature}});
    assert.equal(response.statusCode,200,response.body);assert.equal(submitted,true);
  }finally{await app.close();provider.destroy();}
});
