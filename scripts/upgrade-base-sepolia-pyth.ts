import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import * as ProtocolKit from "@safe-global/protocol-kit";
import { Contract, ContractFactory, Interface, JsonRpcProvider, Wallet, ZeroHash, getAddress, keccak256, toUtf8Bytes, type InterfaceAbi } from "ethers";
import { loadDeploymentConfig } from "./deployment-config.js";

type Identity={address:string;privateKey:string};
type Identities={deployer:Identity;governanceOwners:[Identity,Identity,Identity]};
type Governance={governanceSafe:string;timelock:string};
type Manifest={contracts:{clearingProxy:string;oracleAdapter:string;oracleSource:string};[key:string]:unknown};
type State={candidate:string;operationId:string;salt:string;scheduledTransaction?:string;executedTransaction?:string};

const config=loadDeploymentConfig(process.env);if(config.oracleMode!=="pyth")throw new Error("deployment is not configured for Pyth");
const identities=JSON.parse(readFileSync(resolve(".local-state/testnet-identities.json"),"utf8")) as Identities;
const governance=JSON.parse(readFileSync(resolve(".local-state/base-sepolia-governance.json"),"utf8")) as Governance;
const manifestPath=resolve(".local-state/base-sepolia-deployment.json"),statePath=resolve(".local-state/base-sepolia-pyth-upgrade.json");
const manifest=JSON.parse(readFileSync(manifestPath,"utf8")) as Manifest,provider=new JsonRpcProvider(config.rpcUrl);
if((await provider.getNetwork()).chainId!==84_532n)throw new Error("unexpected chain");

const artifact=JSON.parse(readFileSync(resolve("artifacts/PythCoreAdapter.json"),"utf8")) as {abi:InterfaceAbi;bytecode:string};
let state:State|undefined=existsSync(statePath)?JSON.parse(readFileSync(statePath,"utf8")):process.env.RFQ_PYTH_CANDIDATE_ADDRESS?{candidate:getAddress(process.env.RFQ_PYTH_CANDIDATE_ADDRESS),operationId:ZeroHash,salt:keccak256(toUtf8Bytes("rfq-pyth-bounded-parse-v1"))}:undefined;
if(!state||await provider.getCode(state.candidate)==="0x"){
  const deployed=await new ContractFactory(artifact.abi,artifact.bytecode,new Wallet(identities.deployer.privateKey,provider)).deploy(config.oracleAddress,manifest.contracts.clearingProxy,config.feedIds);
  await deployed.waitForDeployment();const candidate=getAddress(await deployed.getAddress()),salt=keccak256(toUtf8Bytes("rfq-pyth-bounded-parse-v1"));
  state={candidate,operationId:ZeroHash,salt};
}
for(let attempt=0;attempt<20&&await provider.getCode(state.candidate)==="0x";attempt++)await new Promise(resolve=>setTimeout(resolve,1_000));
if(await provider.getCode(state.candidate)==="0x")throw new Error("candidate adapter bytecode unavailable after deployment");
const candidate=new Contract(state.candidate,["function pyth() view returns(address)","function clearing() view returns(address)","function feedIds(uint256) view returns(bytes32)"],provider);
if(getAddress(await candidate.pyth())!==getAddress(config.oracleAddress)||getAddress(await candidate.clearing())!==getAddress(manifest.contracts.clearingProxy)||String(await candidate.feedIds(0)).toLowerCase()!==config.feedIds[0].toLowerCase()||String(await candidate.feedIds(1)).toLowerCase()!==config.feedIds[1].toLowerCase())throw new Error("candidate adapter configuration mismatch");

const clearingData=new Interface(["function setOracle(address)"]).encodeFunctionData("setOracle",[state.candidate]);
const timelock=new Contract(governance.timelock,["function getMinDelay() view returns(uint256)","function hashOperation(address,uint256,bytes,bytes32,bytes32) view returns(bytes32)","function isOperation(bytes32) view returns(bool)","function isOperationReady(bytes32) view returns(bool)","function isOperationDone(bytes32) view returns(bool)","function getTimestamp(bytes32) view returns(uint256)","function schedule(address,uint256,bytes,bytes32,bytes32,uint256)","function execute(address,uint256,bytes,bytes32,bytes32)"],provider);
const delay=await timelock.getMinDelay(),operationId=await timelock.hashOperation(manifest.contracts.clearingProxy,0,clearingData,ZeroHash,state.salt);state.operationId=operationId;

async function safeExecute(data:string){
  const Safe=ProtocolKit.default as unknown as {init(config:Record<string,unknown>):Promise<any>};
  const first=await Safe.init({provider:config.rpcUrl,signer:identities.governanceOwners[0].privateKey,safeAddress:governance.governanceSafe});
  const second=await Safe.init({provider:config.rpcUrl,signer:identities.governanceOwners[1].privateKey,safeAddress:governance.governanceSafe});
  const transaction=await first.createTransaction({transactions:[{to:governance.timelock,value:"0",data}]});const hash=await first.getTransactionHash(transaction);
  transaction.addSignature(await first.signHash(hash));transaction.addSignature(await second.signHash(hash));const execution=await first.executeTransaction(transaction);await execution.transactionResponse?.wait();return execution.hash as string;
}

if(!await timelock.isOperation(operationId)){
  const data=timelock.interface.encodeFunctionData("schedule",[manifest.contracts.clearingProxy,0,clearingData,ZeroHash,state.salt,delay]);state.scheduledTransaction=await safeExecute(data);
}else if(await timelock.isOperationReady(operationId)){
  const data=timelock.interface.encodeFunctionData("execute",[manifest.contracts.clearingProxy,0,clearingData,ZeroHash,state.salt]);state.executedTransaction=await safeExecute(data);
}
if(await timelock.isOperationDone(operationId)){manifest.contracts.oracleAdapter=state.candidate;writeFileSync(manifestPath,JSON.stringify(manifest,null,2)+"\n",{mode:0o600});chmodSync(manifestPath,0o600);}
writeFileSync(statePath,JSON.stringify(state,null,2)+"\n",{mode:0o600});chmodSync(statePath,0o600);
console.log(JSON.stringify({candidate:state.candidate,operationId,delaySeconds:delay.toString(),scheduled:await timelock.isOperation(operationId),ready:await timelock.isOperationReady(operationId),done:await timelock.isOperationDone(operationId),executeAfter:Number(await timelock.getTimestamp(operationId))||null,scheduledTransaction:state.scheduledTransaction,executedTransaction:state.executedTransaction},null,2));
