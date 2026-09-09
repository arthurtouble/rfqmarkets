import { Contract, JsonRpcProvider, Wallet, formatEther } from "ethers";
import { loadDeploymentConfig } from "./deployment-config.js";

const config=loadDeploymentConfig(process.env),provider=new JsonRpcProvider(config.rpcUrl),network=await provider.getNetwork();
if(network.chainId!==84_532n)throw new Error(`expected Base Sepolia chain 84532, received ${network.chainId}`);
const deployer=new Wallet(config.deployerKey,provider),balance=await provider.getBalance(deployer.address);
if(balance<1_000_000_000_000_000n)throw new Error("deployer requires at least 0.001 ETH");
for(const [name,address] of [["USDC",config.usdc],[config.oracleMode==="chainlink"?"VerifierProxy":"Pyth Core",config.oracleAddress],["governance timelock",config.governance],["emergency council",config.emergencyCouncil]] as const)if(await provider.getCode(address)==="0x")throw new Error(`${name} address has no code`);
const token=new Contract(config.usdc,["function decimals() view returns(uint8)"],provider);if(await token.decimals()!==6n)throw new Error("collateral token must expose 6 decimals");
console.log(JSON.stringify({ready:true,chainId:network.chainId.toString(),deployer:deployer.address,deployerEth:formatEther(balance),oracleMode:config.oracleMode,contracts:{usdc:config.usdc,oracleSource:config.oracleAddress,governance:config.governance,emergencyCouncil:config.emergencyCouncil},approvers:config.approvers,feedIds:config.feedIds,feedDecimals:config.feedDecimals,baseRiskCapital:config.baseRiskCapital.toString()},null,2));
