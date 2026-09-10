import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Contract, JsonRpcProvider, Wallet, type InterfaceAbi } from "ethers";
import { PythHermesSource } from "../services/api/src/oracle.js";
import { loadDeploymentConfig } from "./deployment-config.js";

const config=loadDeploymentConfig(process.env);if(config.oracleMode!=="pyth")throw new Error("deployment is not configured for Pyth");
const apiKey=process.env.PYTH_API_KEY;if(!apiKey)throw new Error("missing PYTH_API_KEY");
const manifest=JSON.parse(readFileSync(resolve(".local-state/base-sepolia-deployment.json"),"utf8")) as {contracts:{clearingProxy:string;oracleAdapter:string}};
const artifact=JSON.parse(readFileSync(resolve("artifacts/RFQClearing.json"),"utf8")) as {abi:InterfaceAbi};
const provider=new JsonRpcProvider(config.rpcUrl),signer=new Wallet(config.deployerKey,provider),clearing=new Contract(manifest.contracts.clearingProxy,artifact.abi,signer),adapter=new Contract(manifest.contracts.oracleAdapter,["function updateFee(bytes) view returns(uint256)"],provider);
const source=new PythHermesSource({apiKey,feedIds:{BTC:config.feedIds[0],ETH:config.feedIds[1]},cacheMs:0,timeoutMs:5_000});
const results:Record<string,unknown>={};
for(const market of ["BTC","ETH"] as const){
  const quote=await source.latest(market),fee=await adapter.updateFee(quote.report) as bigint;
  // The signed update has a deliberately short validity window. Supplying the
  // bounded gas limit avoids spending that window on a remote estimateGas call;
  // the transaction still reverts atomically if Pyth or clearing validation fails.
  const transaction=await clearing.refreshOracle(quote.report,{value:fee,gasLimit:750_000n});const receipt=await transaction.wait();if(!receipt||receipt.status!==1)throw new Error(`${market} oracle refresh failed`);
  results[market]={bid:quote.snapshot.bid.toString(),ask:quote.snapshot.ask.toString(),observedAt:Math.floor(quote.snapshot.observedAtMs/1_000),updateFeeWei:fee.toString(),transactionHash:receipt.hash};
}
let verified=false;
for(let attempt=0;attempt<20&&!verified;attempt++){
  const fresh=new Contract(manifest.contracts.clearingProxy,artifact.abi,new JsonRpcProvider(config.rpcUrl)),btc=await fresh.markets(0),eth=await fresh.markets(1);
  verified=BigInt(btc.lastBid)>0n&&BigInt(eth.lastBid)>0n;if(!verified)await new Promise(resolve=>setTimeout(resolve,1_000));
}
if(!verified)throw new Error("Pyth updates mined but clearing observations were not readable");
console.log(JSON.stringify({verified:true,clearingProxy:manifest.contracts.clearingProxy,source:source.status(),markets:results},null,2));
