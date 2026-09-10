import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { Contract, ContractFactory, JsonRpcProvider, Wallet, getAddress, type InterfaceAbi } from "ethers";
import { loadDeploymentConfig } from "./deployment-config.js";
import { linkArtifact } from "./link-artifact.mjs";

type Artifact={abi:InterfaceAbi;bytecode:string};
type Manifest={governance:string;contracts:{clearingProxy:string;clearingImplementation:string;proxyAdmin:string;riskMath:string};[key:string]:unknown};
const IMPLEMENTATION_SLOT="0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const config=loadDeploymentConfig(process.env),manifestPath=resolve(process.env.RFQ_BASE_SEPOLIA_DEPLOYMENT_FILE??".local-state/base-sepolia-iteration.json"),manifest=JSON.parse(readFileSync(manifestPath,"utf8")) as Manifest;
const provider=new JsonRpcProvider(config.rpcUrl,undefined,{batchMaxCount:1}),deployer=new Wallet(config.deployerKey,provider);if((await provider.getNetwork()).chainId!==84_532n)throw new Error("unexpected chain");
if(getAddress(manifest.governance)!==deployer.address)throw new Error("rapid-iteration governance is not the configured deployer");
const artifact=(name:string)=>JSON.parse(readFileSync(resolve("artifacts",`${name}.json`),"utf8")) as Artifact;
const waitForCode=async(name:string,address:string)=>{for(let attempt=0;attempt<30;attempt++){if(await provider.getCode(address)!=="0x")return;await new Promise(resolve=>setTimeout(resolve,1_000));}throw new Error(`${name} bytecode unavailable after 30 seconds`);};

const riskArtifact=artifact("RFQRiskMath"),risk=await new ContractFactory(riskArtifact.abi,riskArtifact.bytecode,deployer).deploy();await risk.waitForDeployment();const riskAddress=await risk.getAddress();await waitForCode("RFQRiskMath",riskAddress);
const clearingArtifact=linkArtifact(artifact("RFQClearing"),{RFQRiskMath:riskAddress}),implementation=await new ContractFactory(clearingArtifact.abi,clearingArtifact.bytecode,deployer).deploy();await implementation.waitForDeployment();const implementationAddress=await implementation.getAddress();await waitForCode("RFQClearing",implementationAddress);
const admin=new Contract(manifest.contracts.proxyAdmin,["function owner() view returns(address)","function upgradeAndCall(address proxy,address implementation,bytes data) payable"],deployer);if(getAddress(await admin.owner())!==deployer.address)throw new Error("rapid-iteration ProxyAdmin is not controlled by the configured deployer");
const transaction=await admin.upgradeAndCall(manifest.contracts.clearingProxy,implementationAddress,"0x");const receipt=await transaction.wait();if(!receipt)throw new Error("upgrade receipt unavailable");
const implementationWord=await provider.getStorage(manifest.contracts.clearingProxy,IMPLEMENTATION_SLOT),active=getAddress(`0x${implementationWord.slice(-40)}`);if(active!==getAddress(implementationAddress))throw new Error("proxy implementation did not change");
manifest.contracts.riskMath=riskAddress;manifest.contracts.clearingImplementation=implementationAddress;manifest.upgradedAt=new Date().toISOString();writeFileSync(manifestPath,JSON.stringify(manifest,null,2)+"\n",{mode:0o600});chmodSync(manifestPath,0o600);
console.log(JSON.stringify({profile:"rapid-iteration",clearingProxy:manifest.contracts.clearingProxy,riskMath:riskAddress,implementation:implementationAddress,transactionHash:receipt.hash,blockNumber:receipt.blockNumber},null,2));
