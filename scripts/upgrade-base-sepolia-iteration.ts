import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { Contract, ContractFactory, JsonRpcProvider, Wallet, getAddress, type InterfaceAbi } from "ethers";
import { loadDeploymentConfig } from "./deployment-config.js";
import { linkArtifact } from "./link-artifact.mjs";

type Artifact={abi:InterfaceAbi;bytecode:string};
type Manifest={governance:string;contracts:{clearingProxy:string;clearingImplementation:string;proxyAdmin:string;riskMath:string;signatureVerifier?:string};exposureControls?:{policy:Array<{grossLimit:string;sideLimit:string}>;migrationCursor?:string;ready:boolean;paused:boolean};upgradeTransactionHash?:string;[key:string]:unknown};
const IMPLEMENTATION_SLOT="0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const config=loadDeploymentConfig(process.env),manifestPath=resolve(process.env.RFQ_BASE_SEPOLIA_DEPLOYMENT_FILE??".local-state/base-sepolia-iteration.json"),manifest=JSON.parse(readFileSync(manifestPath,"utf8")) as Manifest;
const policyPath=process.env.RFQ_EXPOSURE_POLICY_FILE;if(!policyPath)throw new Error("RFQ_EXPOSURE_POLICY_FILE is required: review BTC/ETH grossLimit and sideLimit in raw USDC micro-units before upgrading");
const exposurePolicy=JSON.parse(readFileSync(resolve(policyPath),"utf8")) as Array<{grossLimit:string;sideLimit:string}>;
if(!Array.isArray(exposurePolicy)||exposurePolicy.length!==2||exposurePolicy.some(item=>!item||!/^[1-9]\d*$/.test(item.grossLimit)||!/^[1-9]\d*$/.test(item.sideLimit)||BigInt(item.sideLimit)>BigInt(item.grossLimit)||BigInt(item.grossLimit)>5_000_000_000_000n))throw new Error("invalid exposure policy: two BTC/ETH entries with 0 < sideLimit <= grossLimit <= 5,000,000 USDC required");
const provider=new JsonRpcProvider(config.rpcUrl,undefined,{batchMaxCount:1}),deployer=new Wallet(config.deployerKey,provider);if((await provider.getNetwork()).chainId!==84_532n)throw new Error("unexpected chain");
if(getAddress(manifest.governance)!==deployer.address)throw new Error("rapid-iteration governance is not the configured deployer");
const artifact=(name:string)=>JSON.parse(readFileSync(resolve("artifacts",`${name}.json`),"utf8")) as Artifact;
const waitForCode=async(name:string,address:string)=>{for(let attempt=0;attempt<30;attempt++){if(await provider.getCode(address)!=="0x")return;await new Promise(resolve=>setTimeout(resolve,1_000));}throw new Error(`${name} bytecode unavailable after 30 seconds`);};

const clearing=new Contract(manifest.contracts.clearingProxy,artifact("RFQClearing").abi,deployer);
if(await clearing.resolutionRequired())throw new Error("cannot upgrade an active resolution with the rapid-iteration workflow");
if(!await clearing.paused()){const pausedReceipt=await (await clearing.pause()).wait();if(!pausedReceipt||pausedReceipt.status!==1)throw new Error("pre-upgrade pause failed");}
const implementationWord=await provider.send("eth_getStorageAt",[manifest.contracts.clearingProxy,IMPLEMENTATION_SLOT,"latest"]),activeBefore=getAddress(`0x${String(implementationWord).slice(-40)}`);
const resuming=manifest.exposureControls?.ready===false&&Boolean(manifest.contracts.signatureVerifier)&&activeBefore===getAddress(manifest.contracts.clearingImplementation);
let riskAddress=manifest.contracts.riskMath,signatureAddress=manifest.contracts.signatureVerifier,implementationAddress=manifest.contracts.clearingImplementation,upgradeTransactionHash=manifest.upgradeTransactionHash;
if(!resuming){
 const riskArtifact=artifact("RFQRiskMath"),risk=await new ContractFactory(riskArtifact.abi,riskArtifact.bytecode,deployer).deploy();await risk.waitForDeployment();riskAddress=await risk.getAddress();await waitForCode("RFQRiskMath",riskAddress);
 const signatureArtifact=artifact("RFQSignatureVerifier"),signature=await new ContractFactory(signatureArtifact.abi,signatureArtifact.bytecode,deployer).deploy();await signature.waitForDeployment();signatureAddress=await signature.getAddress();await waitForCode("RFQSignatureVerifier",signatureAddress);
 const clearingArtifact=linkArtifact(artifact("RFQClearing"),{RFQRiskMath:riskAddress,RFQSignatureVerifier:signatureAddress}),implementation=await new ContractFactory(clearingArtifact.abi,clearingArtifact.bytecode,deployer).deploy();await implementation.waitForDeployment();implementationAddress=await implementation.getAddress();await waitForCode("RFQClearing",implementationAddress);
 const admin=new Contract(manifest.contracts.proxyAdmin,["function owner() view returns(address)","function upgradeAndCall(address proxy,address implementation,bytes data) payable"],deployer);if(getAddress(await admin.owner())!==deployer.address)throw new Error("rapid-iteration ProxyAdmin is not controlled by the configured deployer");
 const transaction=await admin.upgradeAndCall(manifest.contracts.clearingProxy,implementationAddress,"0x"),receipt=await transaction.wait();if(!receipt)throw new Error("upgrade receipt unavailable");upgradeTransactionHash=receipt.hash;
 let active:string|undefined;for(let attempt=0;attempt<60;attempt++){const word=await provider.send("eth_getStorageAt",[manifest.contracts.clearingProxy,IMPLEMENTATION_SLOT,"latest"]);active=getAddress(`0x${String(word).slice(-40)}`);if(active===getAddress(implementationAddress))break;await new Promise(resolve=>setTimeout(resolve,1_000));}if(active!==getAddress(implementationAddress))throw new Error(`proxy implementation did not converge after upgrade receipt ${receipt.hash}`);
 // Persist the active implementation before multi-transaction migration; restart must not retain a stale manifest.
 manifest.contracts.signatureVerifier=signatureAddress;manifest.contracts.riskMath=riskAddress;manifest.contracts.clearingImplementation=implementationAddress;manifest.upgradeTransactionHash=upgradeTransactionHash;manifest.upgradedAt=new Date().toISOString();manifest.exposureControls={policy:exposurePolicy,ready:false,paused:true};writeFileSync(manifestPath,JSON.stringify(manifest,null,2)+"\n",{mode:0o600});chmodSync(manifestPath,0o600);
}
if(!signatureAddress)throw new Error("signature verifier is unavailable after upgrade");
for(let market=0;market<2;market++){const policy=exposurePolicy[market],policyReceipt=await (await clearing.setExposurePolicy(market,BigInt(policy.grossLimit),BigInt(policy.sideLimit))).wait();if(!policyReceipt||policyReceipt.status!==1)throw new Error("exposure policy receipt unavailable");}
let exposure=await clearing.exposureState(0);while(!exposure.ready){const migrationReceipt=await (await clearing.migrateExposure(200,{gasLimit:1_500_000})).wait();if(!migrationReceipt||migrationReceipt.status!==1)throw new Error("exposure migration receipt unavailable");let next=await clearing.exposureState(0);for(let attempt=0;attempt<30&&!next.ready&&BigInt(next.cursor)<=BigInt(exposure.cursor);attempt++){await new Promise(resolve=>setTimeout(resolve,1_000));next=await clearing.exposureState(0);}if(!next.ready&&BigInt(next.cursor)<=BigInt(exposure.cursor))throw new Error("exposure migration did not advance");exposure=next;}
manifest.exposureControls={policy:exposurePolicy,migrationCursor:String(exposure.cursor),ready:true,paused:true};
manifest.contracts.signatureVerifier=signatureAddress;manifest.contracts.riskMath=riskAddress;manifest.contracts.clearingImplementation=implementationAddress;manifest.upgradedAt=new Date().toISOString();writeFileSync(manifestPath,JSON.stringify(manifest,null,2)+"\n",{mode:0o600});chmodSync(manifestPath,0o600);
console.log(JSON.stringify({profile:"rapid-iteration",resumed:resuming,paused:true,exposureReady:true,clearingProxy:manifest.contracts.clearingProxy,riskMath:riskAddress,signatureVerifier:signatureAddress,implementation:implementationAddress,upgradeTransactionHash},null,2));
