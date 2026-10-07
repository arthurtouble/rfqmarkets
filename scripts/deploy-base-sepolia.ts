import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { Contract, ContractFactory, Interface, JsonRpcProvider, Wallet, getCreateAddress } from "ethers";
import { loadDeploymentConfig } from "./deployment-config.js";
import { linkArtifact } from "./link-artifact.mjs";
import { MAX_MARKET_CONFIG, linkedLibraries } from "./lib/contract-fixture.mjs";

const config=loadDeploymentConfig(process.env),provider=new JsonRpcProvider(config.rpcUrl),network=await provider.getNetwork();if(network.chainId!==84_532n)throw new Error(`expected Base Sepolia chain 84532, received ${network.chainId}`);
const deployer=new Wallet(config.deployerKey,provider),artifact=(name:string)=>JSON.parse(readFileSync(resolve("artifacts",`${name}.json`),"utf8")),libraries:Record<string,string>={};
const deploy=async(name:string,args:unknown[]=[])=>{
  const item=linkArtifact(artifact(name),libraries),instance=await new ContractFactory(item.abi,item.bytecode,deployer).deploy(...args);
  await instance.waitForDeployment();
  const address=await instance.getAddress();
  for(let attempt=0;attempt<30;attempt++){
    if(await provider.getCode(address)!=="0x")return instance;
    await new Promise(resolve=>setTimeout(resolve,1_000));
  }
  throw new Error(`${name} bytecode was not visible through the deployment RPC after 30 seconds`);
};
// Deploys every linked library (recursively, once) before the contract that links it.
const deployWithLibraries=async(name:string):Promise<Awaited<ReturnType<typeof deploy>>>=>{for(const library of linkedLibraries(artifact(name)))if(!libraries[library])libraries[library]=await (await deployWithLibraries(library)).getAddress();return deploy(name);};
const implementation=await deployWithLibraries("RFQClearing");
// The oracle adapter is bound to the proxy address, so the proxy is deployed right after it.
const predictedProxy=getCreateAddress({from:deployer.address,nonce:(await provider.getTransactionCount(deployer.address,"pending"))+1});
const adapter=config.oracleMode==="chainlink"?await deploy("ChainlinkDataStreamsV3Adapter",[config.oracleAddress,predictedProxy,config.feedIds,config.feedDecimals]):await deploy("PythCoreAdapter",[config.oracleAddress,predictedProxy,config.feedIds]);
const init=new Interface(artifact("RFQClearing").abi).encodeFunctionData("initialize",[config.usdc,await adapter.getAddress(),config.governance,config.emergencyCouncil,config.approvers,config.baseRiskCapital,[MAX_MARKET_CONFIG,MAX_MARKET_CONFIG]]);
const proxy=await deploy("TransparentUpgradeableProxy",[await implementation.getAddress(),config.governance,init]);if((await proxy.getAddress()).toLowerCase()!==predictedProxy.toLowerCase())throw new Error("predicted clearing proxy address mismatch");
const proxyAddress=await proxy.getAddress();let configuration:[string,string,string,bigint,bigint,bigint]|undefined;
for(let attempt=0;attempt<15&&!configuration;attempt++)try{const fresh=new JsonRpcProvider(config.rpcUrl);if(await fresh.getCode(proxyAddress)!=="0x"){const clearing=new Contract(proxyAddress,artifact("RFQClearing").abi,fresh);configuration=await Promise.all([clearing.oracle(),clearing.governance(),clearing.emergencyCouncil(),clearing.leaderEpoch(),clearing.signerSetVersion(),clearing.policyVersion()]) as [string,string,string,bigint,bigint,bigint];}}catch{}finally{if(!configuration)await new Promise(resolve=>setTimeout(resolve,1_000));}
if(!configuration)throw new Error("deployed proxy was not readable after 15 seconds");const [oracle,governance,emergency,epoch,setVersion,policyVersion]=configuration;
if(oracle!==await adapter.getAddress()||governance!==config.governance||emergency!==config.emergencyCouncil||epoch!==1n||setVersion!==1n||policyVersion!==1n)throw new Error("post-deployment configuration mismatch");
const adminWord=await provider.getStorage(proxyAddress,"0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103"),proxyAdmin=`0x${adminWord.slice(-40)}`;
const output={network:"base-sepolia",chainId:network.chainId.toString(),deployer:deployer.address,oracleMode:config.oracleMode,contracts:{clearingProxy:proxyAddress,clearingImplementation:await implementation.getAddress(),proxyAdmin,riskMath:libraries.RFQRiskMath,signatureVerifier:libraries.RFQSignatureVerifier,libraries,oracleAdapter:await adapter.getAddress(),usdc:config.usdc,oracleSource:config.oracleAddress},governance:config.governance,emergencyCouncil:config.emergencyCouncil,approvers:config.approvers,feedIds:config.feedIds,feedDecimals:config.feedDecimals,baseRiskCapital:config.baseRiskCapital.toString(),deployedAt:new Date().toISOString()};
mkdirSync(resolve(".local-state"),{recursive:true});const path=resolve(process.env.RFQ_BASE_SEPOLIA_DEPLOYMENT_FILE??".local-state/base-sepolia-deployment.json");writeFileSync(path,JSON.stringify(output,null,2),{mode:0o600});chmodSync(path,0o600);console.log(JSON.stringify(output,null,2));
