import { Contract, Interface, Wallet, getAddress, type Provider, type Signer } from "ethers";
import { BASE_MAINNET_CHAIN_ID, IMPLEMENTATION_SLOT, PROXY_ADMIN_ABI, artifact, checkExternalDependencies, checkTimelock, estimateDeployCost, factory, libraryOrder, same, timelockOperation, verifyCore, word, type DeploymentRecord } from "./base-mainnet.js";
import { validateDevManifest } from "./mainnet-manifest.js";

// Development profile for Base mainnet: the owner EOA is both clearing governance and ProxyAdmin
// owner, so caps and upgrades apply immediately. Caps are bounded by DEV_CEILINGS. When the product
// is ready, `handoverDev` moves governance and the ProxyAdmin to a Safe-controlled timelock in place.
export type DevManifest=ReturnType<typeof validateDevManifest>;
const PYTH_FEEDS=["0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43","0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace"] as const;

/** Fresh owner, emergency and approver keys plus a dev manifest that uses their addresses. */
export function generateDevIdentities(oracleSource="REPLACE_WITH_PYTH_CORE_ADDRESS"){
  const make=()=>{const wallet=Wallet.createRandom();return {address:wallet.address,privateKey:wallet.privateKey};};
  const identities={owner:make(),emergency:make(),approvers:[make(),make(),make()] as const,createdAt:new Date().toISOString()};
  const market={maxTradeUsdc:"25000000",netUsdc:"100000000",grossUsdc:"200000000",sideUsdc:"150000000"};
  const manifest={version:1,mode:"dev",chainId:"8453",usdc:"0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",oracleSource,feedIds:[...PYTH_FEEDS],
    owner:identities.owner.address,emergencyCouncil:identities.emergency.address,approvers:identities.approvers.map(item=>item.address),
    policy:{makerCapitalUsdc:"100000000",markets:{BTC:market,ETH:market}}};
  return {identities,manifest};
}

/** Read-only checks; the deployer must be the owner so deploy, configure and upgrade run from one key. */
export async function devPreflight(provider:Provider,manifest:DevManifest,deployer:string,expectedChainId=BASE_MAINNET_CHAIN_ID){
  const network=await provider.getNetwork();if(network.chainId!==expectedChainId)throw new Error(`expected chain ${expectedChainId}, RPC reports ${network.chainId}`);
  if(!same(deployer,manifest.owner))throw new Error("dev profile deploys from the owner key; RFQ_MAINNET_DEPLOYER_KEY must belong to manifest.owner");
  await checkExternalDependencies(provider,manifest);
  return {ready:true,profile:"dev",chainId:network.chainId.toString(),...await estimateDeployCost(provider,manifest,deployer)};
}

const confirmed=async(tx:Promise<any>,confirmations:number)=>{const receipt=await (await tx).wait(confirmations);if(!receipt||receipt.status!==1)throw new Error("transaction failed");return receipt.hash as string;};

/** Re-applies the manifest caps (setExposurePolicy requires a paused clearing), then optionally unpauses. v1 deploys paused with the caps already set. */
export async function configureDev(owner:Signer,record:DeploymentRecord,manifest:DevManifest,options:{unpause:boolean;confirmations?:number}){
  const clearing=new Contract(record.contracts.clearingProxy,artifact("RFQClearing").abi,owner),confirmations=options.confirmations??2,transactions:string[]=[];
  const markets=[manifest.policy.markets.BTC,manifest.policy.markets.ETH];
  if(!await clearing.paused())transactions.push(await confirmed(clearing.pause(),confirmations));
  for(const [market,item] of markets.entries())transactions.push(await confirmed(clearing.setExposurePolicy(market,item.grossUsdc,item.sideUsdc),confirmations));
  for(const [market,item] of markets.entries())transactions.push(await confirmed(clearing.setMarketPolicy(market,true,item.maxTradeUsdc,item.netUsdc),confirmations));
  if(options.unpause)transactions.push(await confirmed(clearing.unpause(),confirmations));
  return transactions;
}

/** Unpauses a freshly deployed dev clearing (v1 starts paused). */
export async function unpauseDev(owner:Signer,record:DeploymentRecord,confirmations=2){
  return confirmed(new Contract(record.contracts.clearingProxy,artifact("RFQClearing").abi,owner).unpause(),confirmations);
}

export async function verifyDev(provider:Provider,record:DeploymentRecord,manifest:DevManifest){
  const {checks,state}=await verifyCore(provider,record,manifest);
  return {verified:true,profile:"dev",checks,state};
}

/** Deploys fresh libraries and implementation from the current build and points the proxy at them in one owner transaction. */
export async function upgradeDev(owner:Signer,record:DeploymentRecord,options:{candidateHash:string;confirmations?:number}){
  const provider=owner.provider!,confirmations=options.confirmations??2,libraries:Record<string,string>={};
  const proxyAdmin=new Contract(record.contracts.proxyAdmin,PROXY_ADMIN_ABI,owner);
  if(!same(await proxyAdmin.owner(),await owner.getAddress()))throw new Error("signer does not own the ProxyAdmin");
  const deploy=async(step:string)=>{const contract=await factory(step,libraries,owner).deploy();const receipt=await contract.deploymentTransaction()!.wait(confirmations);if(!receipt||receipt.status!==1)throw new Error(`${step} deployment failed`);return getAddress(receipt.contractAddress!);};
  for(const library of libraryOrder())libraries[library]=await deploy(library);
  const implementation=await deploy("clearingImplementation");
  const transaction=await confirmed(proxyAdmin.upgradeAndCall(record.contracts.clearingProxy,implementation,"0x"),confirmations);
  if(!same(word(await provider.getStorage(record.contracts.clearingProxy,IMPLEMENTATION_SLOT)),implementation))throw new Error("proxy does not point at the new implementation");
  const upgrade={implementation,libraries,transaction,candidateHash:options.candidateHash,at:new Date().toISOString()};
  return {...record,contracts:{...record.contracts,libraries,clearingImplementation:implementation},upgrades:[...(record.upgrades??[]),upgrade]} satisfies DeploymentRecord;
}

/**
 * Moves a dev deployment to production governance in place. The owner sets the emergency Safe, nominates
 * the timelock as governance and hands it the ProxyAdmin. The governance Safe then accepts through the
 * timelock (schedule now, execute after the delay). Until acceptance the owner is still governance.
 */
export async function handoverDev(owner:Signer,record:DeploymentRecord,target:{timelock:string;governanceSafe:string;emergencySafe:string;minimumDelaySeconds:number;confirmations?:number}){
  const provider=owner.provider!,confirmations=target.confirmations??2,ownerAddress=await owner.getAddress();
  const delay=await checkTimelock(provider,target.timelock,target.governanceSafe,target.minimumDelaySeconds,[ownerAddress]);
  for(const [name,address] of [["governance Safe",target.governanceSafe],["emergency Safe",target.emergencySafe]] as const)if(await provider.getCode(address)==="0x")throw new Error(`${name} ${address} has no code`);
  const clearing=new Contract(record.contracts.clearingProxy,artifact("RFQClearing").abi,owner),proxyAdmin=new Contract(record.contracts.proxyAdmin,PROXY_ADMIN_ABI,owner);
  if(!same(await clearing.governance(),ownerAddress)||!same(await proxyAdmin.owner(),ownerAddress))throw new Error("signer is not both clearing governance and ProxyAdmin owner");
  const transactions:Record<string,string>={};
  if(!same(await clearing.emergencyCouncil(),target.emergencySafe))transactions.setEmergencyCouncil=await confirmed(clearing.setEmergencyCouncil(target.emergencySafe),confirmations);
  transactions.transferGovernance=await confirmed(clearing.transferGovernance(target.timelock),confirmations);
  transactions.transferProxyAdmin=await confirmed(proxyAdmin.transferOwnership(target.timelock),confirmations);
  const accept=new Interface(artifact("RFQClearing").abi).encodeFunctionData("acceptGovernance");
  const op=timelockOperation(record.chainId,target.timelock,target.governanceSafe,record.contracts.clearingProxy,[accept],delay,"RFQ governance handover",`rfq-markets:${record.contracts.clearingProxy}:accept-governance`,{schedule:"Schedules acceptGovernance by the timelock.",execute:"Completes the handover after the timelock delay."});
  return {transactions,operation:{id:op.id,salt:op.salt},acceptSchedule:op.schedule,acceptExecute:op.execute};
}
