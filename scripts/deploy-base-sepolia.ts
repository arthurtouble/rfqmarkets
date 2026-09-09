import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { Contract, ContractFactory, Interface, JsonRpcProvider, Wallet, getCreateAddress } from "ethers";
import { loadDeploymentConfig } from "./deployment-config.js";
import { linkArtifact } from "./link-artifact.mjs";

const config=loadDeploymentConfig(process.env),provider=new JsonRpcProvider(config.rpcUrl),network=await provider.getNetwork();if(network.chainId!==84_532n)throw new Error(`expected Base Sepolia chain 84532, received ${network.chainId}`);
const deployer=new Wallet(config.deployerKey,provider),artifact=(name:string)=>JSON.parse(readFileSync(resolve("artifacts",`${name}.json`),"utf8")),libraries:Record<string,string>={};
const deploy=async(name:string,args:unknown[]=[])=>{const item=linkArtifact(artifact(name),libraries);const instance=await new ContractFactory(item.abi,item.bytecode,deployer).deploy(...args);await instance.waitForDeployment();return instance;};
const startingNonce=await provider.getTransactionCount(deployer.address,"pending"),predictedProxy=getCreateAddress({from:deployer.address,nonce:startingNonce+3});
const riskMath=await deploy("RFQRiskMath");libraries.RFQRiskMath=await riskMath.getAddress();const implementation=await deploy("RFQClearing");
const adapter=await deploy("ChainlinkDataStreamsV3Adapter",[config.verifier,predictedProxy,config.feedIds,config.feedDecimals]);
const init=new Interface(artifact("RFQClearing").abi).encodeFunctionData("initialize",[config.usdc,await adapter.getAddress(),config.governance,config.emergencyCouncil,config.approvers,config.baseRiskCapital]);
const proxy=await deploy("TransparentUpgradeableProxy",[await implementation.getAddress(),config.governance,init]);if((await proxy.getAddress()).toLowerCase()!==predictedProxy.toLowerCase())throw new Error("predicted clearing proxy address mismatch");
const clearing=new Contract(await proxy.getAddress(),artifact("RFQClearing").abi,provider);const [oracle,governance,emergency,epoch,setVersion,policyVersion]=await Promise.all([clearing.oracle(),clearing.governance(),clearing.emergencyCouncil(),clearing.leaderEpoch(),clearing.signerSetVersion(),clearing.policyVersion()]);
if(oracle!==await adapter.getAddress()||governance!==config.governance||emergency!==config.emergencyCouncil||epoch!==1n||setVersion!==1n||policyVersion!==1n)throw new Error("post-deployment configuration mismatch");
const adminWord=await provider.getStorage(await proxy.getAddress(),"0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103"),proxyAdmin=`0x${adminWord.slice(-40)}`;
const output={network:"base-sepolia",chainId:network.chainId.toString(),deployer:deployer.address,contracts:{clearingProxy:await proxy.getAddress(),clearingImplementation:await implementation.getAddress(),proxyAdmin,riskMath:await riskMath.getAddress(),oracleAdapter:await adapter.getAddress(),usdc:config.usdc,verifierProxy:config.verifier},governance:config.governance,emergencyCouncil:config.emergencyCouncil,approvers:config.approvers,feedIds:config.feedIds,feedDecimals:config.feedDecimals,baseRiskCapital:config.baseRiskCapital.toString(),deployedAt:new Date().toISOString()};
mkdirSync(resolve(".local-state"),{recursive:true});const path=resolve(".local-state","base-sepolia-deployment.json");writeFileSync(path,JSON.stringify(output,null,2),{mode:0o600});chmodSync(path,0o600);console.log(JSON.stringify(output,null,2));
