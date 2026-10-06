import { Contract, Wallet, getAddress, type Provider, type Signer } from "ethers";
import { BASE_MAINNET_CHAIN_ID, IMPLEMENTATION_SLOT, artifact, estimateDeployCost, factory, same, verifyCore, word, type DeploymentRecord } from "./base-mainnet.js";
import { validateDevManifest } from "./mainnet-manifest.js";

// Development profile for Base mainnet: the owner EOA is both clearing governance and ProxyAdmin
// owner, so caps and upgrades apply immediately. Caps are bounded by DEV_CEILINGS. There is no
// path from this deployment to production governance (the clearing has no governance transfer);
// the production launch is a fresh deployment with the Safe/timelock profile.
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
  for(const [name,address] of [["USDC",manifest.usdc],["Pyth Core",manifest.oracleSource]] as const)if(await provider.getCode(address)==="0x")throw new Error(`${name} ${address} has no code`);
  if(await new Contract(manifest.usdc,["function decimals() view returns(uint8)"],provider).decimals()!==6n)throw new Error("USDC must expose 6 decimals");
  await new Contract(manifest.oracleSource,["function getUpdateFee(bytes[]) view returns(uint256)"],provider).getUpdateFee([]).catch(()=>{throw new Error("Pyth Core address does not answer getUpdateFee")});
  return {ready:true,profile:"dev",chainId:network.chainId.toString(),...await estimateDeployCost(provider,manifest,deployer)};
}

/** Applies the manifest caps immediately (setExposurePolicy requires a paused clearing), then optionally unpauses. */
export async function configureDev(owner:Signer,record:DeploymentRecord,manifest:DevManifest,options:{unpause:boolean;confirmations?:number}){
  const clearing=new Contract(record.contracts.clearingProxy,artifact("RFQClearing").abi,owner),wait=async(tx:Promise<any>)=>{const receipt=await (await tx).wait(options.confirmations??2);if(!receipt||receipt.status!==1)throw new Error("configuration transaction failed");return receipt.hash as string;};
  const transactions:string[]=[],markets=[manifest.policy.markets.BTC,manifest.policy.markets.ETH];
  if(!await clearing.paused())transactions.push(await wait(clearing.pause()));
  for(const [market,item] of markets.entries())transactions.push(await wait(clearing.setExposurePolicy(market,item.grossUsdc,item.sideUsdc)));
  for(const [market,item] of markets.entries())transactions.push(await wait(clearing.setMarketPolicy(market,true,item.maxTradeUsdc,item.netUsdc)));
  if(options.unpause)transactions.push(await wait(clearing.unpause()));
  return transactions;
}

/** Core verification plus the dev caps actually on-chain. */
export async function verifyDev(provider:Provider,record:DeploymentRecord,manifest:DevManifest){
  const {checks,check,state}=await verifyCore(provider,record,manifest);
  const markets=[manifest.policy.markets.BTC,manifest.policy.markets.ETH];
  state.markets.forEach((item,index)=>check(item.maxTradeNotional===markets[index].maxTradeUsdc.toString()&&item.maxMarketNotional===markets[index].netUsdc.toString()&&item.grossLimit===markets[index].grossUsdc.toString()&&item.sideLimit===markets[index].sideUsdc.toString(),`${index===0?"BTC":"ETH"} caps match the dev manifest`));
  return {verified:true,profile:"dev",checks,state};
}

/** Deploys fresh libraries and implementation from the current build and points the proxy at them in one owner transaction. */
export async function upgradeDev(owner:Signer,record:DeploymentRecord,options:{candidateHash:string;confirmations?:number}){
  const provider=owner.provider!,confirmations=options.confirmations??2,addresses:Record<string,string>={};
  for(const step of ["riskMath","signatureVerifier","clearingImplementation"] as const){
    const contract=await factory(step,addresses,owner).deploy();const receipt=await contract.deploymentTransaction()!.wait(confirmations);
    if(!receipt||receipt.status!==1)throw new Error(`${step} deployment failed`);addresses[step]=getAddress(receipt.contractAddress!);
  }
  const proxyAdmin=new Contract(record.contracts.proxyAdmin,["function upgradeAndCall(address,address,bytes) payable","function owner() view returns(address)"],owner);
  if(!same(await proxyAdmin.owner(),await owner.getAddress()))throw new Error("signer does not own the ProxyAdmin");
  const receipt=await (await proxyAdmin.upgradeAndCall(record.contracts.clearingProxy,addresses.clearingImplementation,"0x")).wait(confirmations);
  if(!receipt||receipt.status!==1)throw new Error("upgrade transaction failed");
  if(!same(word(await provider.getStorage(record.contracts.clearingProxy,IMPLEMENTATION_SLOT)),addresses.clearingImplementation))throw new Error("proxy does not point at the new implementation");
  const upgrade={implementation:addresses.clearingImplementation,riskMath:addresses.riskMath,signatureVerifier:addresses.signatureVerifier,transaction:receipt.hash,candidateHash:options.candidateHash,at:new Date().toISOString()};
  return {...record,contracts:{...record.contracts,riskMath:upgrade.riskMath,signatureVerifier:upgrade.signatureVerifier,clearingImplementation:upgrade.implementation},upgrades:[...(record.upgrades??[]),upgrade]} satisfies DeploymentRecord;
}
