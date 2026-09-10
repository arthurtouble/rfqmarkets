import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Contract, JsonRpcProvider, Wallet, parseUnits } from "ethers";
import { loadDeploymentConfig } from "./deployment-config.js";

const config=loadDeploymentConfig(process.env),deployment=JSON.parse(readFileSync(resolve(process.env.RFQ_BASE_SEPOLIA_DEPLOYMENT_FILE??".local-state/base-sepolia-deployment.json"),"utf8")) as {contracts:{clearingProxy:string}};
const provider=new JsonRpcProvider(config.rpcUrl),signer=new Wallet(config.deployerKey,provider),token=new Contract(config.usdc,["function balanceOf(address) view returns(uint256)","function allowance(address,address) view returns(uint256)","function approve(address,uint256) returns(bool)"],signer),clearing=new Contract(deployment.contracts.clearingProxy,["function makerBacking() view returns(uint256)","function insuranceBalance() view returns(uint256)","function fundMaker(uint256)","function fundInsurance(uint256)"],signer);
const makerTarget=parseUnits(process.env.RFQ_TESTNET_MAKER_USDC??"15",6),insuranceTarget=parseUnits(process.env.RFQ_TESTNET_INSURANCE_USDC??"5",6),maker=await clearing.makerBacking() as bigint,insurance=await clearing.insuranceBalance() as bigint,makerDelta=makerTarget>maker?makerTarget-maker:0n,insuranceDelta=insuranceTarget>insurance?insuranceTarget-insurance:0n,total=makerDelta+insuranceDelta,balance=await token.balanceOf(signer.address) as bigint;
if(balance<total)throw new Error(`deployer needs ${total-balance} more USDC micro-units`);if(total>0n&&await token.allowance(signer.address,deployment.contracts.clearingProxy)<total)await (await token.approve(deployment.contracts.clearingProxy,total)).wait();if(makerDelta>0n)await (await clearing.fundMaker(makerDelta)).wait();if(insuranceDelta>0n)await (await clearing.fundInsurance(insuranceDelta)).wait();

let result:{makerBacking:bigint;insuranceBalance:bigint;deployerUsdc:bigint}|undefined;
for(let attempt=0;attempt<20;attempt++){
  const fresh=new JsonRpcProvider(config.rpcUrl);
  const clearingView=new Contract(deployment.contracts.clearingProxy,["function makerBacking() view returns(uint256)","function insuranceBalance() view returns(uint256)"],fresh);
  const tokenView=new Contract(config.usdc,["function balanceOf(address) view returns(uint256)"],fresh);
  result={makerBacking:await clearingView.makerBacking() as bigint,insuranceBalance:await clearingView.insuranceBalance() as bigint,deployerUsdc:await tokenView.balanceOf(signer.address) as bigint};
  if(result.makerBacking>=makerTarget&&result.insuranceBalance>=insuranceTarget)break;
  await new Promise(resolve=>setTimeout(resolve,1_000));
}
if(!result||result.makerBacking<makerTarget||result.insuranceBalance<insuranceTarget)throw new Error("funding transactions mined but expected clearing balances were not observable after 20 seconds");
console.log(JSON.stringify({clearingProxy:deployment.contracts.clearingProxy,makerBacking:result.makerBacking.toString(),insuranceBalance:result.insuranceBalance.toString(),deployerUsdc:result.deployerUsdc.toString()},null,2));
