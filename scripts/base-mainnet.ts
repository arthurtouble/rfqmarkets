import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { AbiCoder, Contract, ContractFactory, Interface, ZeroHash, getAddress, getCreateAddress, id, keccak256, toUtf8Bytes, type Provider, type Signer } from "ethers";
import { linkArtifact } from "./link-artifact.mjs";
import { validateMainnetManifest } from "./mainnet-manifest.js";

// Base mainnet core-contract deployment. Every function here is chain-agnostic so the
// local rehearsal (scripts/base-mainnet-rehearsal.mjs) exercises the exact mainnet code path.
export const BASE_MAINNET_CHAIN_ID=8453n;
export type MainnetManifest=ReturnType<typeof validateMainnetManifest>;
export type DeploymentRecord={network:"base-mainnet";chainId:string;candidateHash:string;launchProfile:"dormant"|"released";deployer:string;contracts:{riskMath:string;signatureVerifier:string;clearingImplementation:string;oracleAdapter:string;clearingProxy:string;proxyAdmin:string;usdc:string;oracleSource:string};governance:string;governanceSafe:string;emergencyCouncil:string;approvers:[string,string,string];feedIds:[string,string];baseRiskCapitalTarget:string;transactions:Record<string,string>;gasUsed:Record<string,string>;deployedAt:string};
type Step="riskMath"|"signatureVerifier"|"clearingImplementation"|"oracleAdapter"|"clearingProxy";
export const DEPLOY_STEPS:Step[]=["riskMath","signatureVerifier","clearingImplementation","oracleAdapter","clearingProxy"];
// Measured in the local rehearsal (initialize + ProxyAdmin creation); used only by the preflight
// estimate because the proxy constructor delegatecalls an implementation that does not exist yet.
export const PROXY_GAS_UPPER_BOUND=1_200_000n;

const ADMIN_SLOT="0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103";
const IMPLEMENTATION_SLOT="0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const ARTIFACT:Record<Step,string>={riskMath:"RFQRiskMath",signatureVerifier:"RFQSignatureVerifier",clearingImplementation:"RFQClearing",oracleAdapter:"PythCoreAdapter",clearingProxy:"TransparentUpgradeableProxy"};
const SOURCE:Record<Step,string>={riskMath:"contracts/libraries/RFQRiskMath.sol",signatureVerifier:"contracts/libraries/RFQSignatureVerifier.sol",clearingImplementation:"contracts/RFQClearing.sol",oracleAdapter:"contracts/oracle/PythCoreAdapter.sol",clearingProxy:"@openzeppelin/contracts/proxy/transparent/TransparentUpgradeableProxy.sol"};
const SAFE_ABI=["function getThreshold() view returns(uint256)","function getOwners() view returns(address[])"];
const TIMELOCK_ABI=["function getMinDelay() view returns(uint256)","function hasRole(bytes32,address) view returns(bool)","function scheduleBatch(address[],uint256[],bytes[],bytes32,bytes32,uint256)","function executeBatch(address[],uint256[],bytes[],bytes32,bytes32) payable","function hashOperationBatch(address[],uint256[],bytes[],bytes32,bytes32) pure returns(bytes32)"];
const ROLES={admin:ZeroHash,proposer:id("PROPOSER_ROLE"),executor:id("EXECUTOR_ROLE"),canceller:id("CANCELLER_ROLE")};

export const artifact=(name:string,root=process.cwd())=>JSON.parse(readFileSync(resolve(root,"artifacts",`${name}.json`),"utf8")) as {abi:any[];bytecode:string;deployedBytecode:string;linkReferences:Record<string,Record<string,{start:number;length:number}[]>>};
const same=(left:string,right:string)=>getAddress(left)===getAddress(right);
const word=(value:string)=>getAddress(`0x${value.slice(-40)}`);

/** Constructor arguments for each step, given library and predicted proxy addresses. */
export function constructorArgs(step:Step,manifest:MainnetManifest,addresses:Partial<Record<Step,string>>,proxy:string,root=process.cwd()):unknown[]{
  if(step==="oracleAdapter")return [manifest.oracleSource,proxy,manifest.feedIds];
  if(step!=="clearingProxy")return [];
  const init=new Interface(artifact("RFQClearing",root).abi).encodeFunctionData("initialize",[manifest.usdc,addresses.oracleAdapter,manifest.governance,manifest.emergencyCouncil,manifest.approvers,manifest.policy.makerCapitalUsdc]);
  return [addresses.clearingImplementation,manifest.governance,init];
}
const factory=(step:Step,addresses:Partial<Record<Step,string>>,signer?:Signer,root=process.cwd())=>{
  const libraries=Object.fromEntries(Object.entries({RFQRiskMath:addresses.riskMath,RFQSignatureVerifier:addresses.signatureVerifier}).filter((entry):entry is [string,string]=>Boolean(entry[1])));
  const item=linkArtifact(artifact(ARTIFACT[step],root),libraries);
  return new ContractFactory(item.abi,item.bytecode,signer);
};

/** Read-only checks against the target chain. Throws on the first failed invariant. */
export async function preflight(provider:Provider,manifest:MainnetManifest,deployer:string,expectedChainId=BASE_MAINNET_CHAIN_ID){
  const network=await provider.getNetwork();if(network.chainId!==expectedChainId)throw new Error(`expected chain ${expectedChainId}, RPC reports ${network.chainId}`);
  if([manifest.governance,manifest.governanceSafe,manifest.emergencyCouncil,...manifest.approvers].some(role=>same(role,deployer)))throw new Error("deployer must not hold any protocol role");
  for(const [name,address] of [["USDC",manifest.usdc],["Pyth Core",manifest.oracleSource],["governance timelock",manifest.governance],["governance Safe",manifest.governanceSafe],["emergency Safe",manifest.emergencyCouncil]] as const)if(await provider.getCode(address)==="0x")throw new Error(`${name} ${address} has no code`);
  const token=new Contract(manifest.usdc,["function decimals() view returns(uint8)"],provider);if(await token.decimals()!==6n)throw new Error("USDC must expose 6 decimals");
  const pyth=new Contract(manifest.oracleSource,["function getUpdateFee(bytes[]) view returns(uint256)"],provider);await pyth.getUpdateFee([]).catch(()=>{throw new Error("Pyth Core address does not answer getUpdateFee")});
  const safes:{label:string;address:string;threshold:number;owners:string[]}[]=[];for(const [label,address] of [["governance",manifest.governanceSafe],["emergency",manifest.emergencyCouncil]] as const){
    const safe=new Contract(address,SAFE_ABI,provider),threshold=await safe.getThreshold() as bigint,owners=(await safe.getOwners() as string[]).map(getAddress);
    if(threshold<2n||owners.length<3)throw new Error(`${label} Safe must be at least 2-of-3 (found ${threshold}-of-${owners.length})`);
    if(owners.some(owner=>same(owner,deployer)))throw new Error(`deployer must not own the ${label} Safe`);
    safes.push({label,address,threshold:Number(threshold),owners});
  }
  const sharedOwners=safes[0].owners.filter(owner=>safes[1].owners.includes(owner));
  if(sharedOwners.length>=safes[1].threshold)throw new Error("governance and emergency Safes share enough owners to act as one");
  const timelock=new Contract(manifest.governance,TIMELOCK_ABI,provider),delay=await timelock.getMinDelay() as bigint;
  if(delay<BigInt(manifest.policy.timelockSeconds))throw new Error(`timelock delay ${delay}s is below manifest ${manifest.policy.timelockSeconds}s`);
  if(!await timelock.hasRole(ROLES.proposer,manifest.governanceSafe)||!await timelock.hasRole(ROLES.executor,manifest.governanceSafe))throw new Error("governance Safe must be timelock proposer and executor");
  if(await timelock.hasRole(ROLES.admin,manifest.governanceSafe))throw new Error("governance Safe still holds timelock admin; execute the renounce batch first");
  if(!await timelock.hasRole(ROLES.admin,manifest.governance))throw new Error("timelock must be self-administered");
  for(const role of Object.values(ROLES))if(await timelock.hasRole(role,deployer))throw new Error("deployer holds a timelock role");
  const nonce=await provider.getTransactionCount(deployer,"pending"),balance=await provider.getBalance(deployer),fee=await provider.getFeeData();
  // Library/implementation/adapter gas is estimated live from their creation code; the proxy uses the rehearsal bound.
  const predicted:Partial<Record<Step,string>>={};DEPLOY_STEPS.forEach((step,index)=>predicted[step]=getCreateAddress({from:deployer,nonce:nonce+index}));
  const gas:Record<string,bigint>={};let totalBytes=0;
  for(const step of DEPLOY_STEPS){
    const tx=await factory(step,predicted,undefined).getDeployTransaction(...constructorArgs(step,manifest,predicted,predicted.clearingProxy!));totalBytes+=(tx.data!.length-2)/2;
    gas[step]=step==="clearingProxy"?PROXY_GAS_UPPER_BOUND:await provider.estimateGas({...tx,from:deployer});
  }
  const totalGas=Object.values(gas).reduce((sum,value)=>sum+value,0n),maxFeePerGas=fee.maxFeePerGas??fee.gasPrice??0n;
  let l1Fee:bigint|null=null;try{l1Fee=await new Contract("0x420000000000000000000000000000000000000F",["function getL1FeeUpperBound(uint256) view returns(uint256)"],provider).getL1FeeUpperBound(totalBytes+DEPLOY_STEPS.length*120) as bigint;}catch{}
  const estimatedWei=totalGas*maxFeePerGas+(l1Fee??0n);
  if(balance<estimatedWei*2n)throw new Error(`deployer balance ${balance} wei is below twice the estimated ${estimatedWei} wei`);
  return {ready:true,chainId:network.chainId.toString(),deployer,nonce,balanceWei:balance.toString(),predicted,gas:Object.fromEntries(Object.entries(gas).map(([key,value])=>[key,value.toString()])),totalGas:totalGas.toString(),maxFeePerGasWei:maxFeePerGas.toString(),l1FeeUpperBoundWei:l1Fee?.toString()??"unavailable",estimatedCostWei:estimatedWei.toString(),timelockDelaySeconds:delay.toString(),safes};
}

/**
 * Deploys the five core transactions in a fixed order. `resume` holds addresses from an interrupted
 * run; steps whose code is already on-chain are skipped, and the oracle adapter is re-checked against
 * the proxy address the remaining nonces will produce.
 */
export async function deployCore(signer:Signer,manifest:MainnetManifest,options:{candidateHash:string;launchProfile:"dormant"|"released";confirmations?:number;resume?:Partial<Record<Step,string>>;onStep?:(step:Step,address:string,partial:Partial<Record<Step,string>>)=>void;root?:string}){
  const provider=signer.provider!;const deployer=await signer.getAddress(),root=options.root??process.cwd(),confirmations=options.confirmations??2;
  const addresses:Partial<Record<Step,string>>={},transactions:Record<string,string>={},gasUsed:Record<string,string>={};
  for(const step of DEPLOY_STEPS){const prior=options.resume?.[step];if(prior&&await provider.getCode(prior)!=="0x")addresses[step]=getAddress(prior);}
  const remaining=DEPLOY_STEPS.filter(step=>!addresses[step]);
  let nonce=await provider.getTransactionCount(deployer,"pending");
  const proxy=addresses.clearingProxy??getCreateAddress({from:deployer,nonce:nonce+remaining.indexOf("clearingProxy")});
  if(addresses.oracleAdapter&&!addresses.clearingProxy){const bound=await new Contract(addresses.oracleAdapter,["function clearing() view returns(address)"],provider).clearing() as string;if(!same(bound,proxy))throw new Error(`existing oracle adapter is bound to ${bound}, but the next proxy will be ${proxy}; remove oracleAdapter from the resume file`);}
  for(const step of remaining){
    const contract=await factory(step,addresses,signer,root).deploy(...constructorArgs(step,manifest,addresses,proxy,root),{nonce:nonce++});
    const receipt=await contract.deploymentTransaction()!.wait(confirmations);if(!receipt||receipt.status!==1)throw new Error(`${step} deployment failed`);
    addresses[step]=getAddress(receipt.contractAddress!);transactions[step]=receipt.hash;gasUsed[step]=receipt.gasUsed.toString();
    if(await provider.getCode(addresses[step]!)==="0x")throw new Error(`${step} has no code after ${confirmations} confirmations`);
    options.onStep?.(step,addresses[step]!,{...addresses});
  }
  if(!same(addresses.clearingProxy!,proxy))throw new Error("clearing proxy address does not match the address bound into the oracle adapter");
  const record:DeploymentRecord={network:"base-mainnet",chainId:(await provider.getNetwork()).chainId.toString(),candidateHash:options.candidateHash,launchProfile:options.launchProfile,deployer,
    contracts:{riskMath:addresses.riskMath!,signatureVerifier:addresses.signatureVerifier!,clearingImplementation:addresses.clearingImplementation!,oracleAdapter:addresses.oracleAdapter!,clearingProxy:addresses.clearingProxy!,proxyAdmin:word(await provider.getStorage(addresses.clearingProxy!,ADMIN_SLOT)),usdc:manifest.usdc,oracleSource:manifest.oracleSource},
    governance:manifest.governance,governanceSafe:manifest.governanceSafe,emergencyCouncil:manifest.emergencyCouncil,approvers:manifest.approvers,feedIds:manifest.feedIds,baseRiskCapitalTarget:manifest.policy.makerCapitalUsdc.toString(),transactions,gasUsed,deployedAt:new Date().toISOString()};
  return record;
}

// Linked library placeholders are `__$<first 34 hex of keccak(fully-qualified name)>$__`.
const placeholder=(fullyQualified:string)=>`__$${keccak256(toUtf8Bytes(fullyQualified)).slice(2,36)}$__`;
/** Zeroes immutable slots, which the constructor fills (e.g. a library's own address under viaIR). */
const maskImmutables=(code:string,references:Record<string,{start:number;length:number}[]>={})=>{
  let hex=code.toLowerCase().slice(2);
  for(const ranges of Object.values(references))for(const {start,length} of ranges)hex=hex.slice(0,start*2)+"0".repeat(length*2)+hex.slice((start+length)*2);
  return `0x${hex}`;
};
/** True when on-chain runtime code equals the local build once libraries are linked and immutables masked. */
export function runtimeMatches(onChain:string,name:string,libraries:Record<string,string>={},root=process.cwd()){
  const item=artifact(name,root) as ReturnType<typeof artifact>&{immutableReferences?:Record<string,{start:number;length:number}[]>};
  let expected=item.deployedBytecode;
  for(const [library,address] of Object.entries(libraries))expected=expected.split(placeholder(`contracts/libraries/${library}.sol:${library}`)).join(address.slice(2).toLowerCase());
  if(expected.includes("__$"))throw new Error(`unlinked library placeholder remains in ${name} runtime code`);
  return maskImmutables(onChain,item.immutableReferences)===maskImmutables(expected,item.immutableReferences);
}

/** On-chain verification of a mainnet deployment record against its manifest. Throws on mismatch. */
export async function verifyDeployment(provider:Provider,record:DeploymentRecord,manifest:MainnetManifest,root=process.cwd()){
  const checks:string[]=[],check=(ok:boolean,label:string)=>{if(!ok)throw new Error(`verification failed: ${label}`);checks.push(label);};
  check((await provider.getNetwork()).chainId.toString()===record.chainId,"RPC chain matches the deployment record");
  for(const [name,address] of Object.entries(record.contracts))check(await provider.getCode(address)!=="0x",`${name} has code`);
  check(runtimeMatches(await provider.getCode(record.contracts.clearingImplementation),"RFQClearing",{RFQRiskMath:record.contracts.riskMath,RFQSignatureVerifier:record.contracts.signatureVerifier},root),"implementation runtime bytecode equals the local build with linked libraries");
  for(const [step,name] of [["riskMath","RFQRiskMath"],["signatureVerifier","RFQSignatureVerifier"]] as const)check(runtimeMatches(await provider.getCode(record.contracts[step]),name,{},root),`${name} runtime bytecode equals the local build`);
  check(same(word(await provider.getStorage(record.contracts.clearingProxy,IMPLEMENTATION_SLOT)),record.contracts.clearingImplementation),"proxy points at the recorded implementation");
  check(same(word(await provider.getStorage(record.contracts.clearingProxy,ADMIN_SLOT)),record.contracts.proxyAdmin),"proxy admin slot matches the record");
  const proxyAdmin=new Contract(record.contracts.proxyAdmin,["function owner() view returns(address)"],provider);check(same(await proxyAdmin.owner(),manifest.governance),"ProxyAdmin is owned by the governance timelock");
  const clearing=new Contract(record.contracts.clearingProxy,artifact("RFQClearing",root).abi,provider);
  check(same(await clearing.usdc(),manifest.usdc),"clearing collateral is Base USDC");
  check(same(await clearing.oracle(),record.contracts.oracleAdapter),"clearing oracle is the recorded adapter");
  check(same(await clearing.governance(),manifest.governance),"clearing governance is the timelock");
  check(same(await clearing.emergencyCouncil(),manifest.emergencyCouncil),"clearing emergency council is the emergency Safe");
  for(let index=0;index<3;index++)check(same(await clearing.approvers(index),manifest.approvers[index]),`approver ${index+1} matches the manifest`);
  check(await clearing.baseRiskCapitalTarget()===manifest.policy.makerCapitalUsdc,"maker capital floor matches the manifest");
  const adapter=new Contract(record.contracts.oracleAdapter,["function pyth() view returns(address)","function clearing() view returns(address)","function feedIds(uint256) view returns(bytes32)"],provider);
  check(same(await adapter.pyth(),manifest.oracleSource)&&same(await adapter.clearing(),record.contracts.clearingProxy),"oracle adapter binds Pyth Core and the clearing proxy");
  for(let index=0;index<2;index++)check((await adapter.feedIds(index)).toLowerCase()===manifest.feedIds[index].toLowerCase(),`oracle feed ${index===0?"BTC":"ETH"} matches the manifest`);
  const timelock=new Contract(manifest.governance,TIMELOCK_ABI,provider);
  check(await timelock.getMinDelay()>=BigInt(manifest.policy.timelockSeconds),"timelock delay meets the manifest minimum");
  check(!await timelock.hasRole(ROLES.admin,manifest.governanceSafe)&&await timelock.hasRole(ROLES.admin,manifest.governance),"timelock is self-administered");
  for(const role of Object.values(ROLES))check(!await timelock.hasRole(role,record.deployer),`deployer holds no timelock role ${role.slice(0,10)}`);
  const state={paused:await clearing.paused() as boolean,markets:[] as {enabled:boolean;maxTradeNotional:string;maxMarketNotional:string;grossLimit:string;sideLimit:string}[]};
  for(let market=0;market<2;market++){const [info,limits,exposure]=await Promise.all([clearing.markets(market),clearing.marketLimitWord(market),clearing.exposureState(market)]);const mask=(1n<<128n)-1n;state.markets.push({enabled:info.enabled,maxTradeNotional:(limits&mask).toString(),maxMarketNotional:(limits>>128n).toString(),grossLimit:(exposure.limits&mask).toString(),sideLimit:(exposure.limits>>128n).toString()});}
  return {verified:true,checks,state};
}

type SafeBatch={version:"1.0";chainId:string;createdAt:number;meta:{name:string;description:string;txBuilderVersion:string;createdFromSafeAddress:string};transactions:{to:string;value:"0";data:string;contractMethod:null;contractInputsValues:null}[]};
const safeBatch=(chainId:string,safe:string,name:string,description:string,calls:{to:string;data:string}[]):SafeBatch=>({version:"1.0",chainId,createdAt:Date.now(),meta:{name,description,txBuilderVersion:"1.16.5",createdFromSafeAddress:safe},transactions:calls.map(call=>({to:call.to,value:"0",data:call.data,contractMethod:null,contractInputsValues:null}))});

/** Timelock renounce batch for the governance Safe, needed once after deploying the mainnet timelock. */
export function renounceTimelockAdminBatch(chainId:string,timelock:string,governanceSafe:string){
  return safeBatch(chainId,governanceSafe,"RFQ timelock: renounce bootstrap admin","Leaves the timelock self-administered. Execute before the clearing deployment.",[{to:timelock,data:new Interface(["function renounceRole(bytes32,address)"]).encodeFunctionData("renounceRole",[ZeroHash,governanceSafe])}]);
}

/**
 * Safe Transaction Builder batches that take a fresh deployment to the manifest's canary policy.
 * 1. emergency: pause and disable both markets at canary caps (no delay; emergency may only reduce risk).
 * 2. governance schedule: one timelock call scheduling `configure` (exposure caps, enable markets) and `goLive` (unpause).
 * 3/4. governance execute: run after the delay; goLive is held until approvers, keeper, hedger and monitoring are live.
 */
export function launchBatches(record:DeploymentRecord,manifest:MainnetManifest,root=process.cwd()){
  const clearing=new Interface(artifact("RFQClearing",root).abi),timelock=new Interface(TIMELOCK_ABI),proxy=record.contracts.clearingProxy;
  const markets=[manifest.policy.markets.BTC,manifest.policy.markets.ETH];
  const emergency=[{to:proxy,data:clearing.encodeFunctionData("pause")},...markets.map((item,market)=>({to:proxy,data:clearing.encodeFunctionData("setMarketPolicy",[market,false,item.maxTradeUsdc,item.netUsdc])}))];
  const configureCalls=[...markets.map((item,market)=>clearing.encodeFunctionData("setExposurePolicy",[market,item.grossUsdc,item.sideUsdc])),...markets.map((item,market)=>clearing.encodeFunctionData("setMarketPolicy",[market,true,item.maxTradeUsdc,item.netUsdc]))];
  const coder=AbiCoder.defaultAbiCoder();
  const operation=(label:string,payloads:string[],predecessor:string)=>{
    const targets=payloads.map(()=>proxy),values=payloads.map(()=>0n),salt=id(`rfq-markets:${record.candidateHash}:${label}`);
    // Matches TimelockController.hashOperationBatch.
    return {targets,values,payloads,predecessor,salt,id:keccak256(coder.encode(["address[]","uint256[]","bytes[]","bytes32","bytes32"],[targets,values,payloads,predecessor,salt]))};
  };
  const configure=operation("configure",configureCalls,ZeroHash),goLive=operation("go-live",[clearing.encodeFunctionData("unpause")],configure.id);
  const schedule=(op:typeof configure)=>({to:manifest.governance,data:timelock.encodeFunctionData("scheduleBatch",[op.targets,op.values,op.payloads,op.predecessor,op.salt,manifest.policy.timelockSeconds])});
  const execute=(op:typeof configure)=>({to:manifest.governance,data:timelock.encodeFunctionData("executeBatch",[op.targets,op.values,op.payloads,op.predecessor,op.salt])});
  return {
    operations:{configure:{id:configure.id,salt:configure.salt},goLive:{id:goLive.id,salt:goLive.salt,predecessor:goLive.predecessor}},
    emergencyPause:safeBatch(record.chainId,manifest.emergencyCouncil,"RFQ launch 1: pause and disable markets","Run immediately after deployment. Reduces risk only.",emergency),
    governanceSchedule:safeBatch(record.chainId,manifest.governanceSafe,"RFQ launch 2: schedule canary policy and go-live",`Schedules configure and go-live with the ${manifest.policy.timelockSeconds}s timelock delay.`,[schedule(configure),schedule(goLive)]),
    governanceConfigure:safeBatch(record.chainId,manifest.governanceSafe,"RFQ launch 3: apply canary caps","Executable after the timelock delay. Clearing must still be paused.",[execute(configure)]),
    governanceGoLive:safeBatch(record.chainId,manifest.governanceSafe,"RFQ launch 4: unpause","Execute only after approvers, keeper, hedger and monitoring are live and verified.",[execute(goLive)]),
  };
}

/** Standard-JSON verification payloads for Basescan (Etherscan API v2). */
export function basescanSubmissions(record:DeploymentRecord,manifest:MainnetManifest,root=process.cwd()){
  const build=JSON.parse(readFileSync(resolve(root,"artifacts/build-info/rfq-build.json"),"utf8")) as {solcLongVersion:string;input:{settings:Record<string,unknown>}};
  const proxy=record.contracts.clearingProxy,addresses:Partial<Record<Step,string>>=record.contracts;
  return DEPLOY_STEPS.map(step=>{
    const libraries=step==="clearingImplementation"?{"contracts/libraries/RFQRiskMath.sol":{RFQRiskMath:record.contracts.riskMath},"contracts/libraries/RFQSignatureVerifier.sol":{RFQSignatureVerifier:record.contracts.signatureVerifier}}:{};
    const input={...build.input,settings:{...build.input.settings,outputSelection:{"*":{"*":["abi","evm.bytecode","evm.deployedBytecode"]}},libraries}};
    const args=factory(step,addresses,undefined,root).interface.encodeDeploy(constructorArgs(step,manifest,addresses,proxy,root)).slice(2);
    return {step,address:record.contracts[step],contractName:`${SOURCE[step]}:${ARTIFACT[step]}`,compilerVersion:`v${build.solcLongVersion.replace(/\.Emscripten\.clang$/,"")}`,input,constructorArguments:args};
  });
}
