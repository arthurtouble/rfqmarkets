import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { AbiCoder, Contract, ContractFactory, Interface, ZeroHash, getAddress, getCreateAddress, id, keccak256, toUtf8Bytes, type Provider, type Signer } from "ethers";
import { linkArtifact } from "./link-artifact.mjs";
import { validateMainnetManifest } from "./mainnet-manifest.js";

// Base mainnet core-contract deployment. Every function here is chain-agnostic so the
// local rehearsal (scripts/base-mainnet-rehearsal.ts) exercises the exact mainnet code path.
export const BASE_MAINNET_CHAIN_ID=8453n;
export type MainnetManifest=ReturnType<typeof validateMainnetManifest>;
export type MarketCaps={maxTradeUsdc:bigint;netUsdc:bigint;grossUsdc:bigint;sideUsdc:bigint};
/** The subset of a manifest the deployment consumes (shared by production and dev profiles). */
export type CoreInputs={usdc:string;oracleSource:string;feedIds:[string,string];governance:string;emergencyCouncil:string;approvers:[string,string,string];policy:{makerCapitalUsdc:bigint;markets:{BTC:MarketCaps;ETH:MarketCaps}}};
export type DeploymentContracts={libraries:Record<string,string>;clearingImplementation:string;oracleAdapter:string;clearingProxy:string;proxyAdmin:string;usdc:string;oracleSource:string};
export type DeploymentRecord={network:"base-mainnet";chainId:string;candidateHash:string;launchProfile:"dormant"|"released"|"dev";deployer:string;contracts:DeploymentContracts;governance:string;governanceSafe:string|null;emergencyCouncil:string;approvers:[string,string,string];feedIds:[string,string];baseRiskCapitalTarget:string;transactions:Record<string,string>;gasUsed:Record<string,string>;deployedAt:string;proxyInitImplementation?:string;upgrades?:{implementation:string;libraries:Record<string,string>;transaction:string;candidateHash:string;at:string}[]};
type Artifact={source:string;abi:any[];bytecode:string;deployedBytecode:string;linkReferences:Record<string,Record<string,{start:number;length:number}[]>>;immutableReferences?:Record<string,{start:number;length:number}[]>};
// Measured in the local rehearsal (initialize + ProxyAdmin creation); used only by the preflight
// estimate because the proxy constructor delegatecalls an implementation that does not exist yet.
export const PROXY_GAS_UPPER_BOUND=1_500_000n;

export const ADMIN_SLOT="0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103";
export const IMPLEMENTATION_SLOT="0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const PROXY_ARTIFACT="TransparentUpgradeableProxy",PROXY_SOURCE="@openzeppelin/contracts/proxy/transparent/TransparentUpgradeableProxy.sol";
const SAFE_ABI=["function getThreshold() view returns(uint256)","function getOwners() view returns(address[])"];
export const TIMELOCK_ABI=["function getMinDelay() view returns(uint256)","function hasRole(bytes32,address) view returns(bool)","function scheduleBatch(address[],uint256[],bytes[],bytes32,bytes32,uint256)","function executeBatch(address[],uint256[],bytes[],bytes32,bytes32) payable"];
export const TIMELOCK_ROLES={admin:ZeroHash,proposer:id("PROPOSER_ROLE"),executor:id("EXECUTOR_ROLE"),canceller:id("CANCELLER_ROLE")};
export const PROXY_ADMIN_ABI=["function owner() view returns(address)","function upgradeAndCall(address,address,bytes) payable","function transferOwnership(address)"];

export const artifact=(name:string,root=process.cwd())=>JSON.parse(readFileSync(resolve(root,"artifacts",`${name}.json`),"utf8")) as Artifact;
export const same=(left:string,right:string)=>getAddress(left)===getAddress(right);
export const word=(value:string)=>getAddress(`0x${value.slice(-40)}`);
const linkedNames=(item:Artifact)=>[...new Set(Object.values(item.linkReferences??{}).flatMap(references=>Object.keys(references)))];

/** Libraries RFQClearing links, dependencies first, so each can be linked when it is deployed. */
export function libraryOrder(root=process.cwd()){
  const order:string[]=[],visit=(name:string)=>{for(const library of linkedNames(artifact(name,root)))if(!order.includes(library)){visit(library);order.push(library);}};
  visit("RFQClearing");return order;
}
/** Deployment steps: every library, then implementation, oracle adapter (bound to the predicted proxy) and proxy. */
export const deploySteps=(root=process.cwd())=>[...libraryOrder(root),"clearingImplementation","oracleAdapter","clearingProxy"];
const artifactFor=(step:string)=>step==="clearingImplementation"?"RFQClearing":step==="oracleAdapter"?"PythCoreAdapter":step==="clearingProxy"?PROXY_ARTIFACT:step;

export const marketConfigs=(manifest:CoreInputs)=>[manifest.policy.markets.BTC,manifest.policy.markets.ETH].map(item=>({enabled:true,maxTradeNotional:item.maxTradeUsdc,maxMarketNotional:item.netUsdc,grossLimit:item.grossUsdc,sideLimit:item.sideUsdc}));
/** Constructor arguments for a step, given deployed (or predicted) addresses. The proxy initializes paused with the manifest caps. */
export function constructorArgs(step:string,manifest:CoreInputs,addresses:Record<string,string>,proxy:string,root=process.cwd()):unknown[]{
  if(step==="oracleAdapter")return [manifest.oracleSource,proxy,manifest.feedIds];
  if(step!=="clearingProxy")return [];
  const init=new Interface(artifact("RFQClearing",root).abi).encodeFunctionData("initialize",[manifest.usdc,addresses.oracleAdapter,manifest.governance,manifest.emergencyCouncil,manifest.approvers,manifest.policy.makerCapitalUsdc,marketConfigs(manifest)]);
  return [addresses.clearingImplementation,manifest.governance,init];
}
export const factory=(step:string,libraries:Record<string,string>,signer?:Signer,root=process.cwd())=>{
  const item=artifact(artifactFor(step),root),needed=Object.fromEntries(linkedNames(item).map(name=>[name,libraries[name]]));
  const linked=linkArtifact(item,needed);return new ContractFactory(linked.abi,linked.bytecode,signer);
};
const librariesOf=(addresses:Record<string,string>,root=process.cwd())=>Object.fromEntries(libraryOrder(root).filter(name=>addresses[name]).map(name=>[name,addresses[name]]));

/** Read-only checks against the target chain for the production (Safe + timelock) profile. */
export async function preflight(provider:Provider,manifest:MainnetManifest,deployer:string,expectedChainId=BASE_MAINNET_CHAIN_ID){
  const network=await provider.getNetwork();if(network.chainId!==expectedChainId)throw new Error(`expected chain ${expectedChainId}, RPC reports ${network.chainId}`);
  if([manifest.governance,manifest.governanceSafe,manifest.emergencyCouncil,...manifest.approvers].some(role=>same(role,deployer)))throw new Error("deployer must not hold any protocol role");
  await checkExternalDependencies(provider,manifest);
  for(const [name,address] of [["governance timelock",manifest.governance],["governance Safe",manifest.governanceSafe],["emergency Safe",manifest.emergencyCouncil]] as const)if(await provider.getCode(address)==="0x")throw new Error(`${name} ${address} has no code`);
  const safes:{label:string;address:string;threshold:number;owners:string[]}[]=[];for(const [label,address] of [["governance",manifest.governanceSafe],["emergency",manifest.emergencyCouncil]] as const){
    const safe=new Contract(address,SAFE_ABI,provider),threshold=await safe.getThreshold() as bigint,owners=(await safe.getOwners() as string[]).map(getAddress);
    if(threshold<2n||owners.length<3)throw new Error(`${label} Safe must be at least 2-of-3 (found ${threshold}-of-${owners.length})`);
    if(owners.some(owner=>same(owner,deployer)))throw new Error(`deployer must not own the ${label} Safe`);
    safes.push({label,address,threshold:Number(threshold),owners});
  }
  const sharedOwners=safes[0].owners.filter(owner=>safes[1].owners.includes(owner));
  if(sharedOwners.length>=safes[1].threshold)throw new Error("governance and emergency Safes share enough owners to act as one");
  const delay=await checkTimelock(provider,manifest.governance,manifest.governanceSafe,manifest.policy.timelockSeconds,[deployer]);
  return {ready:true,chainId:network.chainId.toString(),...await estimateDeployCost(provider,manifest,deployer),timelockDelaySeconds:delay.toString(),safes};
}

/** USDC decimals and a responsive Pyth Core contract. */
export async function checkExternalDependencies(provider:Provider,manifest:Pick<CoreInputs,"usdc"|"oracleSource">){
  for(const [name,address] of [["USDC",manifest.usdc],["Pyth Core",manifest.oracleSource]] as const)if(await provider.getCode(address)==="0x")throw new Error(`${name} ${address} has no code`);
  if(await new Contract(manifest.usdc,["function decimals() view returns(uint8)"],provider).decimals()!==6n)throw new Error("USDC must expose 6 decimals");
  await new Contract(manifest.oracleSource,["function getUpdateFee(bytes[]) view returns(uint256)"],provider).getUpdateFee([]).catch(()=>{throw new Error("Pyth Core address does not answer getUpdateFee")});
}

/** A self-administered timelock whose proposer and executor is the governance Safe, with no role for `outsiders`. */
export async function checkTimelock(provider:Provider,timelockAddress:string,governanceSafe:string,minimumDelay:number,outsiders:string[]){
  if(await provider.getCode(timelockAddress)==="0x")throw new Error(`timelock ${timelockAddress} has no code`);
  const timelock=new Contract(timelockAddress,TIMELOCK_ABI,provider),delay=await timelock.getMinDelay() as bigint;
  if(delay<BigInt(minimumDelay))throw new Error(`timelock delay ${delay}s is below the required ${minimumDelay}s`);
  if(!await timelock.hasRole(TIMELOCK_ROLES.proposer,governanceSafe)||!await timelock.hasRole(TIMELOCK_ROLES.executor,governanceSafe))throw new Error("governance Safe must be timelock proposer and executor");
  if(await timelock.hasRole(TIMELOCK_ROLES.admin,governanceSafe))throw new Error("governance Safe still holds timelock admin; execute the renounce batch first");
  if(!await timelock.hasRole(TIMELOCK_ROLES.admin,timelockAddress))throw new Error("timelock must be self-administered");
  for(const outsider of outsiders)for(const role of Object.values(TIMELOCK_ROLES))if(await timelock.hasRole(role,outsider))throw new Error(`${outsider} holds a timelock role`);
  return delay;
}

/** Live gas/fee estimate for the deployment; refuses a deployer holding under twice the estimate. */
export async function estimateDeployCost(provider:Provider,manifest:CoreInputs,deployer:string,root=process.cwd()){
  const nonce=await provider.getTransactionCount(deployer,"pending"),balance=await provider.getBalance(deployer),fee=await provider.getFeeData(),steps=deploySteps(root);
  // Creation code is estimated live against predicted addresses; the proxy uses the rehearsal bound.
  const predicted:Record<string,string>={};steps.forEach((step,index)=>predicted[step]=getCreateAddress({from:deployer,nonce:nonce+index}));
  const gas:Record<string,bigint>={};let totalBytes=0;
  for(const step of steps){
    const tx=await factory(step,predicted,undefined,root).getDeployTransaction(...constructorArgs(step,manifest,predicted,predicted.clearingProxy,root));totalBytes+=(tx.data!.length-2)/2;
    gas[step]=step==="clearingProxy"?PROXY_GAS_UPPER_BOUND:await provider.estimateGas({...tx,from:deployer});
  }
  const totalGas=Object.values(gas).reduce((sum,value)=>sum+value,0n),maxFeePerGas=fee.maxFeePerGas??fee.gasPrice??0n;
  let l1Fee:bigint|null=null;try{l1Fee=await new Contract("0x420000000000000000000000000000000000000F",["function getL1FeeUpperBound(uint256) view returns(uint256)"],provider).getL1FeeUpperBound(totalBytes+steps.length*120) as bigint;}catch{}
  const estimatedWei=totalGas*maxFeePerGas+(l1Fee??0n);
  if(balance<estimatedWei*2n)throw new Error(`deployer balance ${balance} wei is below twice the estimated ${estimatedWei} wei`);
  return {deployer,nonce,balanceWei:balance.toString(),predicted,gas:Object.fromEntries(Object.entries(gas).map(([key,value])=>[key,value.toString()])),totalGas:totalGas.toString(),maxFeePerGasWei:maxFeePerGas.toString(),l1FeeUpperBoundWei:l1Fee?.toString()??"unavailable",estimatedCostWei:estimatedWei.toString()};
}

/**
 * Deploys every library, the implementation, the oracle adapter and the proxy in a fixed order. `resume`
 * holds addresses from an interrupted run; steps whose code is already on-chain are skipped, and the
 * oracle adapter is re-checked against the proxy address the remaining nonces will produce.
 */
export async function deployCore(signer:Signer,manifest:CoreInputs&{governanceSafe?:string},options:{candidateHash:string;launchProfile:DeploymentRecord["launchProfile"];confirmations?:number;resume?:Record<string,string>;onStep?:(step:string,address:string,partial:Record<string,string>)=>void;root?:string}){
  const provider=signer.provider!;const deployer=await signer.getAddress(),root=options.root??process.cwd(),confirmations=options.confirmations??2,steps=deploySteps(root);
  const addresses:Record<string,string>={},transactions:Record<string,string>={},gasUsed:Record<string,string>={};
  for(const step of steps){const prior=options.resume?.[step];if(prior&&await provider.getCode(prior)!=="0x")addresses[step]=getAddress(prior);}
  const remaining=steps.filter(step=>!addresses[step]);
  let nonce=await provider.getTransactionCount(deployer,"pending");
  const proxy=addresses.clearingProxy??getCreateAddress({from:deployer,nonce:nonce+remaining.indexOf("clearingProxy")});
  if(addresses.oracleAdapter&&!addresses.clearingProxy){const bound=await new Contract(addresses.oracleAdapter,["function clearing() view returns(address)"],provider).clearing() as string;if(!same(bound,proxy))throw new Error(`existing oracle adapter is bound to ${bound}, but the next proxy will be ${proxy}; remove oracleAdapter from the resume file`);}
  for(const step of remaining){
    const contract=await factory(step,addresses,signer,root).deploy(...constructorArgs(step,manifest,addresses,proxy,root),{nonce:nonce++});
    const receipt=await contract.deploymentTransaction()!.wait(confirmations);if(!receipt||receipt.status!==1)throw new Error(`${step} deployment failed`);
    addresses[step]=getAddress(receipt.contractAddress!);transactions[step]=receipt.hash;gasUsed[step]=receipt.gasUsed.toString();
    if(await provider.getCode(addresses[step])==="0x")throw new Error(`${step} has no code after ${confirmations} confirmations`);
    options.onStep?.(step,addresses[step],{...addresses});
  }
  if(!same(addresses.clearingProxy,proxy))throw new Error("clearing proxy address does not match the address bound into the oracle adapter");
  const record:DeploymentRecord={network:"base-mainnet",chainId:(await provider.getNetwork()).chainId.toString(),candidateHash:options.candidateHash,launchProfile:options.launchProfile,deployer,
    contracts:{libraries:librariesOf(addresses,root),clearingImplementation:addresses.clearingImplementation,oracleAdapter:addresses.oracleAdapter,clearingProxy:addresses.clearingProxy,proxyAdmin:word(await provider.getStorage(addresses.clearingProxy,ADMIN_SLOT)),usdc:manifest.usdc,oracleSource:manifest.oracleSource},
    governance:manifest.governance,governanceSafe:manifest.governanceSafe??null,emergencyCouncil:manifest.emergencyCouncil,approvers:manifest.approvers,feedIds:manifest.feedIds,baseRiskCapitalTarget:manifest.policy.makerCapitalUsdc.toString(),transactions,gasUsed,deployedAt:new Date().toISOString(),proxyInitImplementation:addresses.clearingImplementation};
  return record;
}

/** Zeroes immutable slots, which the constructor fills (e.g. a library's own address under viaIR). */
const maskImmutables=(code:string,references:Record<string,{start:number;length:number}[]>={})=>{
  let hex=code.toLowerCase().slice(2);
  for(const ranges of Object.values(references))for(const {start,length} of ranges)hex=hex.slice(0,start*2)+"0".repeat(length*2)+hex.slice((start+length)*2);
  return `0x${hex}`;
};
// Linked library placeholders are `__$<first 34 hex of keccak(fully-qualified name)>$__`.
const placeholder=(fullyQualified:string)=>`__$${keccak256(toUtf8Bytes(fullyQualified)).slice(2,36)}$__`;
/** True when on-chain runtime code equals the local build once libraries are linked and immutables masked. */
export function runtimeMatches(onChain:string,name:string,libraries:Record<string,string>,root=process.cwd()){
  const item=artifact(name,root);let expected=item.deployedBytecode;
  for(const [source,references] of Object.entries(item.linkReferences??{}))for(const library of Object.keys(references)){
    const address=libraries[library];if(!address)throw new Error(`no address for ${library}, linked by ${name}`);
    expected=expected.split(placeholder(`${source}:${library}`)).join(address.slice(2).toLowerCase());
  }
  if(expected.includes("__$"))throw new Error(`unlinked library placeholder remains in ${name} runtime code`);
  return maskImmutables(onChain,item.immutableReferences)===maskImmutables(expected,item.immutableReferences);
}

/** Checks shared by every profile: code identity, proxy wiring, roles, approvers, capital floor, caps and oracle binding. */
export async function verifyCore(provider:Provider,record:DeploymentRecord,manifest:CoreInputs,root=process.cwd()){
  const checks:string[]=[],check=(ok:boolean,label:string)=>{if(!ok)throw new Error(`verification failed: ${label}`);checks.push(label);};
  const {libraries,...contracts}=record.contracts;
  check((await provider.getNetwork()).chainId.toString()===record.chainId,"RPC chain matches the deployment record");
  for(const [name,address] of [...Object.entries(contracts),...Object.entries(libraries)])check(await provider.getCode(address)!=="0x",`${name} has code`);
  check(runtimeMatches(await provider.getCode(contracts.clearingImplementation),"RFQClearing",libraries,root),"implementation runtime bytecode equals the local build with linked libraries");
  for(const [name,address] of Object.entries(libraries))check(runtimeMatches(await provider.getCode(address),name,libraries,root),`${name} runtime bytecode equals the local build`);
  check(same(word(await provider.getStorage(contracts.clearingProxy,IMPLEMENTATION_SLOT)),contracts.clearingImplementation),"proxy points at the recorded implementation");
  check(same(word(await provider.getStorage(contracts.clearingProxy,ADMIN_SLOT)),contracts.proxyAdmin),"proxy admin slot matches the record");
  check(same(await new Contract(contracts.proxyAdmin,PROXY_ADMIN_ABI,provider).owner(),manifest.governance),"ProxyAdmin is owned by governance");
  const clearing=new Contract(contracts.clearingProxy,artifact("RFQClearing",root).abi,provider);
  check(same(await clearing.usdc(),manifest.usdc),"clearing collateral is Base USDC");
  check(same(await clearing.oracle(),contracts.oracleAdapter),"clearing oracle is the recorded adapter");
  check(same(await clearing.governance(),manifest.governance),"clearing governance matches the manifest");
  check(same(await clearing.emergencyCouncil(),manifest.emergencyCouncil),"clearing emergency council matches the manifest");
  for(let index=0;index<3;index++)check(same(await clearing.approvers(index),manifest.approvers[index]),`approver ${index+1} matches the manifest`);
  check(await clearing.baseRiskCapitalTarget()===manifest.policy.makerCapitalUsdc,"maker capital floor matches the manifest");
  const adapter=new Contract(contracts.oracleAdapter,["function pyth() view returns(address)","function clearing() view returns(address)","function feedIds(uint256) view returns(bytes32)"],provider);
  check(same(await adapter.pyth(),manifest.oracleSource)&&same(await adapter.clearing(),contracts.clearingProxy),"oracle adapter binds Pyth Core and the clearing proxy");
  for(let index=0;index<2;index++)check((await adapter.feedIds(index)).toLowerCase()===manifest.feedIds[index].toLowerCase(),`oracle feed ${index===0?"BTC":"ETH"} matches the manifest`);
  const mask=(1n<<128n)-1n,state={paused:await clearing.paused() as boolean,pendingGovernance:await clearing.pendingGovernance() as string,markets:[] as {enabled:boolean;maxTradeNotional:string;maxMarketNotional:string;grossLimit:string;sideLimit:string}[]};
  for(let market=0;market<2;market++){const [info,limits,exposure]=await Promise.all([clearing.markets(market),clearing.marketLimitWord(market),clearing.exposureState(market)]);state.markets.push({enabled:info.enabled,maxTradeNotional:(limits&mask).toString(),maxMarketNotional:(limits>>128n).toString(),grossLimit:(exposure.limits&mask).toString(),sideLimit:(exposure.limits>>128n).toString()});}
  marketConfigs(manifest).forEach((config,index)=>check(state.markets[index].maxTradeNotional===config.maxTradeNotional.toString()&&state.markets[index].maxMarketNotional===config.maxMarketNotional.toString()&&state.markets[index].grossLimit===config.grossLimit.toString()&&state.markets[index].sideLimit===config.sideLimit.toString(),`${index===0?"BTC":"ETH"} caps match the manifest`));
  return {verified:true,checks,check,state};
}

/** Production verification: core checks plus timelock delay, self-administration and no deployer role. */
export async function verifyDeployment(provider:Provider,record:DeploymentRecord,manifest:MainnetManifest,root=process.cwd()){
  const {checks,check,state}=await verifyCore(provider,record,manifest,root);
  await checkTimelock(provider,manifest.governance,manifest.governanceSafe,manifest.policy.timelockSeconds,[record.deployer]);
  check(true,"timelock is self-administered with the required delay, and the deployer holds no timelock role");
  return {verified:true,checks,state};
}

type SafeBatch={version:"1.0";chainId:string;createdAt:number;meta:{name:string;description:string;txBuilderVersion:string;createdFromSafeAddress:string};transactions:{to:string;value:"0";data:string;contractMethod:null;contractInputsValues:null}[]};
export const safeBatch=(chainId:string,safe:string,name:string,description:string,calls:{to:string;data:string}[]):SafeBatch=>({version:"1.0",chainId,createdAt:Date.now(),meta:{name,description,txBuilderVersion:"1.16.5",createdFromSafeAddress:safe},transactions:calls.map(call=>({to:call.to,value:"0",data:call.data,contractMethod:null,contractInputsValues:null}))});

/** Timelock renounce batch for the governance Safe, needed once after deploying the mainnet timelock. */
export function renounceTimelockAdminBatch(chainId:string,timelock:string,governanceSafe:string){
  return safeBatch(chainId,governanceSafe,"RFQ timelock: renounce bootstrap admin","Leaves the timelock self-administered. Execute before the timelock takes over governance.",[{to:timelock,data:new Interface(["function renounceRole(bytes32,address)"]).encodeFunctionData("renounceRole",[ZeroHash,governanceSafe])}]);
}

/** A schedule batch and an execute batch for one timelock operation whose calls all target `target`. */
export function timelockOperation(chainId:string,timelock:string,governanceSafe:string,target:string,payloads:string[],delaySeconds:number|bigint,label:string,salt:string,describe:{schedule:string;execute:string}){
  const iface=new Interface(TIMELOCK_ABI),targets=payloads.map(()=>target),values=payloads.map(()=>0n),saltHash=id(salt);
  // Matches TimelockController.hashOperationBatch.
  const operationId=keccak256(AbiCoder.defaultAbiCoder().encode(["address[]","uint256[]","bytes[]","bytes32","bytes32"],[targets,values,payloads,ZeroHash,saltHash]));
  return {id:operationId,salt:saltHash,
    schedule:safeBatch(chainId,governanceSafe,`${label}: schedule`,describe.schedule,[{to:timelock,data:iface.encodeFunctionData("scheduleBatch",[targets,values,payloads,ZeroHash,saltHash,delaySeconds])}]),
    execute:safeBatch(chainId,governanceSafe,`${label}: execute`,describe.execute,[{to:timelock,data:iface.encodeFunctionData("executeBatch",[targets,values,payloads,ZeroHash,saltHash])}])};
}

/**
 * Production go-live. v1 initializes paused with the manifest caps, so the only governance step left is
 * a timelocked `unpause`, held until approvers, keeper, hedger and monitoring are live.
 */
export function launchBatches(record:DeploymentRecord,manifest:MainnetManifest,root=process.cwd()){
  const unpause=new Interface(artifact("RFQClearing",root).abi).encodeFunctionData("unpause");
  const op=timelockOperation(record.chainId,manifest.governance,manifest.governanceSafe,record.contracts.clearingProxy,[unpause],manifest.policy.timelockSeconds,"RFQ go-live",`rfq-markets:${record.candidateHash}:go-live`,{schedule:`Schedules unpause with the ${manifest.policy.timelockSeconds}s timelock delay.`,execute:"Execute only after approvers, keeper, hedger and monitoring are live and verified."});
  return {operations:{goLive:{id:op.id,salt:op.salt}},governanceSchedule:op.schedule,governanceGoLive:op.execute};
}

/** Standard-JSON verification payloads for Basescan (Etherscan API v2). */
export function basescanSubmissions(record:DeploymentRecord,manifest:CoreInputs,root=process.cwd()){
  const build=JSON.parse(readFileSync(resolve(root,"artifacts/build-info/rfq-build.json"),"utf8")) as {solcLongVersion:string;input:{settings:Record<string,unknown>}};
  const {libraries:deployedLibraries,...contracts}=record.contracts,addresses:Record<string,string>={...deployedLibraries,...contracts};
  // The proxy's constructor arguments name the implementation it was created with, not a later upgrade.
  const proxyArgs={...addresses,clearingImplementation:record.proxyInitImplementation??contracts.clearingImplementation};
  const settingsLibraries:Record<string,Record<string,string>>={};for(const [name,address] of Object.entries(deployedLibraries))(settingsLibraries[artifact(name,root).source]??={})[name]=address;
  const steps=[...Object.keys(deployedLibraries),"clearingImplementation","oracleAdapter","clearingProxy"];
  return steps.map(step=>{
    const name=artifactFor(step),source=step==="clearingProxy"?PROXY_SOURCE:artifact(name,root).source;
    const input={...build.input,settings:{...build.input.settings,outputSelection:{"*":{"*":["abi","evm.bytecode","evm.deployedBytecode"]}},libraries:settingsLibraries}};
    const args=factory(step,addresses,undefined,root).interface.encodeDeploy(constructorArgs(step,manifest,step==="clearingProxy"?proxyArgs:addresses,contracts.clearingProxy,root)).slice(2);
    return {step,address:addresses[step],contractName:`${source}:${name}`,compilerVersion:`v${build.solcLongVersion.replace(/\.Emscripten\.clang$/,"")}`,input,constructorArguments:args};
  });
}
