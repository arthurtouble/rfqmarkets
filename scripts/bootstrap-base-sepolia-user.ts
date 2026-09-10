import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Contract, JsonRpcProvider, Wallet, parseEther, parseUnits } from "ethers";
import { loadDeploymentConfig } from "./deployment-config.js";

type Identity={address:string;privateKey:string};const config=loadDeploymentConfig(process.env),identities=JSON.parse(readFileSync(resolve(".local-state/testnet-identities.json"),"utf8")) as {deployer:Identity;sponsor:Identity},deployment=JSON.parse(readFileSync(resolve(".local-state/base-sepolia-deployment.json"),"utf8")) as {contracts:{clearingProxy:string}};
let provider=new JsonRpcProvider(config.rpcUrl);const deployer=new Wallet(identities.deployer.privateKey,provider),traderAddress=identities.sponsor.address,gasTarget=parseEther("0.001"),gasBalance=await provider.getBalance(traderAddress);if(gasBalance<gasTarget)await (await deployer.sendTransaction({to:traderAddress,value:gasTarget-gasBalance})).wait();
for(let attempt=0;attempt<15;attempt++){provider=new JsonRpcProvider(config.rpcUrl);if(await provider.getBalance(traderAddress)>=gasTarget)break;await new Promise(resolve=>setTimeout(resolve,1_000));}const trader=new Wallet(identities.sponsor.privateKey,provider);if(await provider.getBalance(trader.address)<gasTarget)throw new Error("test trader gas transfer was not observable after 15 seconds");
const token=new Contract(config.usdc,["function balanceOf(address) view returns(uint256)","function allowance(address,address) view returns(uint256)","function approve(address,uint256) returns(bool)"],trader),clearing=new Contract(deployment.contracts.clearingProxy,["function collateralOf(address) view returns(int256)","function deposit(uint256)"],trader),target=parseUnits(process.env.RFQ_TESTNET_USER_COLLATERAL_USDC??"10",6),current=await clearing.collateralOf(trader.address) as bigint,delta=target>current?target-current:0n,balance=await token.balanceOf(trader.address) as bigint;
if(balance<delta)throw new Error(`test trader needs ${delta-balance} more USDC micro-units`);if(delta>0n&&await token.allowance(trader.address,deployment.contracts.clearingProxy)<delta)await (await token.approve(deployment.contracts.clearingProxy,delta)).wait();if(delta>0n)await (await clearing.deposit(delta)).wait();

let result:{collateral:bigint;gasWei:bigint;walletUsdc:bigint}|undefined;
for(let attempt=0;attempt<20;attempt++){
  const fresh=new JsonRpcProvider(config.rpcUrl);
  const view=new Contract(deployment.contracts.clearingProxy,["function collateralOf(address) view returns(int256)"],fresh);
  const tokenView=new Contract(config.usdc,["function balanceOf(address) view returns(uint256)"],fresh);
  result={collateral:await view.collateralOf(trader.address) as bigint,gasWei:await fresh.getBalance(trader.address),walletUsdc:await tokenView.balanceOf(trader.address) as bigint};
  if(result.collateral>=target)break;
  await new Promise(resolve=>setTimeout(resolve,1_000));
}
if(!result||result.collateral<target)throw new Error("deposit transaction mined but expected trader collateral was not observable after 20 seconds");
console.log(JSON.stringify({trader:trader.address,collateral:result.collateral.toString(),walletUsdc:result.walletUsdc.toString(),gasWei:result.gasWei.toString()},null,2));
