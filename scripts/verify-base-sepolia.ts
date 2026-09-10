import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Contract, JsonRpcProvider, getAddress } from "ethers";

const deployment=JSON.parse(readFileSync(resolve(process.env.RFQ_BASE_SEPOLIA_DEPLOYMENT_FILE??".local-state/base-sepolia-deployment.json"),"utf8")) as {chainId:string;oracleMode:string;contracts:Record<string,string>;governance:string;emergencyCouncil:string;approvers:string[];feedIds:string[]};
const roles=JSON.parse(readFileSync(resolve(".local-state/base-sepolia-governance.json"),"utf8")) as {governanceSafe:string;emergencySafe:string;timelock:string;governanceOwners:string[];emergencyOwners:string[];threshold:number;timelockDelaySeconds:number};
const iteration=process.env.RFQ_TESTNET_ITERATION==="true";
const provider=new JsonRpcProvider(process.env.RFQ_BASE_SEPOLIA_RPC_URL??"https://sepolia.base.org");if((await provider.getNetwork()).chainId!==BigInt(deployment.chainId))throw new Error("deployment chain mismatch");
const codeTargets=iteration?{...deployment.contracts,emergencyCouncil:deployment.emergencyCouncil}:{...deployment.contracts,governance:deployment.governance,emergencyCouncil:deployment.emergencyCouncil,governanceSafe:roles.governanceSafe};
for(const [name,address] of Object.entries(codeTargets))if(await provider.getCode(address)==="0x")throw new Error(`${name} has no code`);
const clearing=new Contract(deployment.contracts.clearingProxy,["function oracle() view returns(address)","function governance() view returns(address)","function emergencyCouncil() view returns(address)","function leaderEpoch() view returns(uint64)","function signerSetVersion() view returns(uint64)","function policyVersion() view returns(uint64)","function approvers(uint256) view returns(address)"],provider);
const adapter=new Contract(deployment.contracts.oracleAdapter,["function pyth() view returns(address)","function clearing() view returns(address)","function feedIds(uint256) view returns(bytes32)"],provider);
const proxyAdmin=new Contract(deployment.contracts.proxyAdmin,["function owner() view returns(address)"],provider),timelock=new Contract(roles.timelock,["function getMinDelay() view returns(uint256)","function hasRole(bytes32,address) view returns(bool)"],provider),safeAbi=["function getThreshold() view returns(uint256)","function getOwners() view returns(address[])"];
const governanceSafe=new Contract(roles.governanceSafe,safeAbi,provider),emergencySafe=new Contract(roles.emergencySafe,safeAbi,provider);
const same=(left:string,right:string)=>getAddress(left)===getAddress(right);if(!same(await clearing.oracle(),deployment.contracts.oracleAdapter)||!same(await clearing.governance(),deployment.governance)||!same(await clearing.emergencyCouncil(),deployment.emergencyCouncil))throw new Error("clearing role mismatch");
if(!same(await proxyAdmin.owner(),deployment.governance))throw new Error("upgrade governance mismatch");
if(!iteration){
  if(await timelock.getMinDelay()!==BigInt(roles.timelockDelaySeconds))throw new Error("timelock delay mismatch");
  if(await timelock.hasRole("0x0000000000000000000000000000000000000000000000000000000000000000",roles.governanceSafe))throw new Error("governance Safe still has direct timelock admin role");
  if(!await timelock.hasRole("0x0000000000000000000000000000000000000000000000000000000000000000",roles.timelock))throw new Error("timelock is not self-administered");
}
if(deployment.oracleMode!=="pyth"||!same(await adapter.pyth(),deployment.contracts.oracleSource)||!same(await adapter.clearing(),deployment.contracts.clearingProxy))throw new Error("oracle adapter mismatch");
for(let index=0;index<2;index++)if((await adapter.feedIds(index)).toLowerCase()!==deployment.feedIds[index].toLowerCase())throw new Error("oracle feed mismatch");
for(let index=0;index<3;index++)if(!same(await clearing.approvers(index),deployment.approvers[index]))throw new Error("approver mismatch");
if(!iteration)for(const [label,safe,owners] of [["governance",governanceSafe,roles.governanceOwners],["emergency",emergencySafe,roles.emergencyOwners]] as const){if(await safe.getThreshold()!==BigInt(roles.threshold))throw new Error(`${label} threshold mismatch`);const actual=(await safe.getOwners() as string[]).map(getAddress);if(owners.some(owner=>!actual.includes(getAddress(owner))))throw new Error(`${label} owners mismatch`);}
const output={verified:true,profile:iteration?"rapid-iteration":"governed",chainId:deployment.chainId,clearingProxy:deployment.contracts.clearingProxy,oracleMode:deployment.oracleMode,governance:deployment.governance,emergencyCouncil:deployment.emergencyCouncil,proxyAdmin:deployment.contracts.proxyAdmin,leaderEpoch:(await clearing.leaderEpoch()).toString(),signerSetVersion:(await clearing.signerSetVersion()).toString(),policyVersion:(await clearing.policyVersion()).toString()};console.log(JSON.stringify(output,null,2));
