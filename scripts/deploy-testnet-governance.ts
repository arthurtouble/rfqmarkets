import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import * as ProtocolKit from "@safe-global/protocol-kit";
import { Contract, ContractFactory, JsonRpcProvider, Wallet, getAddress, type InterfaceAbi } from "ethers";

type Identity={address:string;privateKey:string};
type Bundle={deployer:Identity;governanceOwners:[Identity,Identity,Identity];emergencyOwners:[Identity,Identity,Identity]};
const secretPath=resolve(".local-state/testnet-identities.json"),outputPath=resolve(".local-state/base-sepolia-governance.json"),envPath=resolve("base-sepolia.env");
const bundle=JSON.parse(readFileSync(secretPath,"utf8")) as Bundle,provider=new JsonRpcProvider("https://sepolia.base.org"),deployer=new Wallet(bundle.deployer.privateKey,provider);
const Safe=ProtocolKit.default as unknown as {init(config:Record<string,unknown>):Promise<any>};
if((await provider.getNetwork()).chainId!==84_532n)throw new Error("unexpected chain");

async function deploySafe(label:string,owners:Identity[],saltNonce:string){
  const protocol=await Safe.init({provider:"https://sepolia.base.org",signer:bundle.deployer.privateKey,predictedSafe:{safeAccountConfig:{owners:owners.map(item=>item.address),threshold:2},safeDeploymentConfig:{saltNonce,safeVersion:"1.4.1"}}});
  const address=getAddress(await protocol.getAddress());
  if(await provider.getCode(address)==="0x"){
    const prepared=await protocol.createSafeDeploymentTransaction();
    const receipt=await (await deployer.sendTransaction({to:prepared.to,data:prepared.data,value:BigInt(prepared.value)})).wait();
    if(!receipt||receipt.status!==1)throw new Error(`${label} Safe deployment failed`);
  }
  let code="0x";for(let attempt=0;attempt<10&&code==="0x";attempt++){code=await new JsonRpcProvider("https://sepolia.base.org").getCode(address);if(code==="0x")await new Promise(resolve=>setTimeout(resolve,1_000));}
  if(code==="0x")throw new Error(`${label} Safe bytecode unavailable after deployment`);
  const safe=new Contract(address,["function getThreshold() view returns(uint256)","function getOwners() view returns(address[])"] as InterfaceAbi,provider);
  if(await safe.getThreshold()!==2n)throw new Error(`${label} Safe validation failed`);
  const actual=(await safe.getOwners() as string[]).map(getAddress),expected=owners.map(item=>getAddress(item.address));
  if(actual.length!==expected.length||expected.some(item=>!actual.includes(item)))throw new Error(`${label} Safe owners mismatch`);
  return address;
}

const governanceSafe=await deploySafe("governance",bundle.governanceOwners,"84532001");
const emergencySafe=await deploySafe("emergency",bundle.emergencyOwners,"84532002");
const artifact=JSON.parse(readFileSync(resolve("artifacts/RFQTimelock.json"),"utf8")) as {abi:InterfaceAbi;bytecode:string};
let timelock:string;
if(existsOutput()){
  const prior=JSON.parse(readFileSync(outputPath,"utf8")) as {timelock?:string};timelock=prior.timelock&&await provider.getCode(prior.timelock)!=="0x"?getAddress(prior.timelock):"";
}else timelock="";
if(!timelock){const deployed=await new ContractFactory(artifact.abi,artifact.bytecode,deployer).deploy(governanceSafe);await deployed.waitForDeployment();timelock=getAddress(await deployed.getAddress());}
const output={network:"base-sepolia",chainId:"84532",governanceSafe,emergencySafe,timelock,governanceOwners:bundle.governanceOwners.map(item=>item.address),emergencyOwners:bundle.emergencyOwners.map(item=>item.address),threshold:2,timelockDelaySeconds:259200,deployedAt:new Date().toISOString()};
writeFileSync(outputPath,JSON.stringify(output,null,2),{mode:0o600});chmodSync(outputPath,0o600);
let env=readFileSync(envPath,"utf8");env=replaceEnv(env,"RFQ_GOVERNANCE_ADDRESS",timelock);env=replaceEnv(env,"RFQ_EMERGENCY_COUNCIL_ADDRESS",emergencySafe);writeFileSync(envPath,env,{mode:0o600});chmodSync(envPath,0o600);
console.log(JSON.stringify(output,null,2));

function existsOutput(){try{readFileSync(outputPath);return true;}catch{return false;}}
function replaceEnv(source:string,key:string,value:string){const line=`${key}=${value}`;return new RegExp(`^${key}=.*$`,`m`).test(source)?source.replace(new RegExp(`^${key}=.*$`,`m`),line):`${source.trimEnd()}\n${line}\n`;}
