import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { ContractFactory, JsonRpcProvider, Wallet, formatEther, getAddress } from "ethers";
import { BASE_MAINNET_CHAIN_ID, artifact, basescanSubmissions, deployCore, launchBatches, preflight, renounceTimelockAdminBatch, verifyDeployment, type DeploymentRecord } from "./base-mainnet.js";
import { identifyCandidate } from "./candidate-identity.js";
import { validateMainnetManifest } from "./mainnet-manifest.js";
import { checkReleaseEvidence } from "./release-evidence.js";

// Usage (see BASE-MAINNET-DEPLOYMENT.md):
//   candidate         (prints this checkout's candidate hash for the manifest)
//   preflight         MANIFEST
//   deploy-timelock   GOVERNANCE_SAFE
//   deploy            MANIFEST (--dormant | --release-evidence FILE)
//   verify            MANIFEST
//   batches           MANIFEST
//   basescan          MANIFEST
const STATE=resolve(process.env.RFQ_MAINNET_STATE_DIR??".local-state/base-mainnet");
const RECORD=resolve(STATE,"deployment.json"),PARTIAL=resolve(STATE,"deployment.partial.json");
const [command,target,...flags]=process.argv.slice(2);
const env=(name:string)=>{const value=process.env[name];if(!value)throw new Error(`${name} is required`);return value;};
const rpc=(name="RFQ_BASE_MAINNET_RPC_URL")=>{const url=env(name);if(!url.startsWith("https://"))throw new Error(`${name} must use HTTPS`);return new JsonRpcProvider(url,undefined,{staticNetwork:false});};
const writePrivate=(path:string,value:unknown)=>{mkdirSync(dirname(path),{recursive:true});writeFileSync(path,JSON.stringify(value,null,2)+"\n",{mode:0o600});chmodSync(path,0o600);};
const loadManifest=()=>{if(!target)throw new Error("MANIFEST path is required");const manifest=validateMainnetManifest(JSON.parse(readFileSync(resolve(target),"utf8")));const candidate=identifyCandidate();if(candidate.candidateHash!==manifest.candidateHash)throw new Error(`manifest candidate ${manifest.candidateHash.slice(0,12)} does not match this checkout (${candidate.candidateHash.slice(0,12)})`);return manifest;};
const loadRecord=()=>JSON.parse(readFileSync(RECORD,"utf8")) as DeploymentRecord;
const deployerWallet=(provider:JsonRpcProvider)=>new Wallet(env("RFQ_MAINNET_DEPLOYER_KEY"),provider);
// Mainnet broadcasts need a typed confirmation bound to the chain, deployer and candidate.
const confirm=(action:string,deployer:string,suffix:string)=>{const expected=`${action}-8453-${deployer.toLowerCase()}-${suffix}`;if(process.env.RFQ_MAINNET_DEPLOY_CONFIRM!==expected)throw new Error(`refusing to broadcast. Set RFQ_MAINNET_DEPLOY_CONFIRM=${expected}`);};
const requireMainnet=async(provider:JsonRpcProvider)=>{const chainId=(await provider.getNetwork()).chainId;if(chainId!==BASE_MAINNET_CHAIN_ID)throw new Error(`expected Base mainnet 8453, RPC reports ${chainId}`);};

switch(command){
  case "candidate":console.log(identifyCandidate().candidateHash);break;
  case "preflight":{
    const manifest=loadManifest(),provider=rpc(),deployer=process.env.RFQ_MAINNET_DEPLOYER_ADDRESS?getAddress(process.env.RFQ_MAINNET_DEPLOYER_ADDRESS):deployerWallet(provider).address;
    const report=await preflight(provider,manifest,deployer);console.log(JSON.stringify({...report,balanceEth:formatEther(report.balanceWei),estimatedCostEth:formatEther(report.estimatedCostWei)},null,2));break;
  }
  case "deploy-timelock":{
    if(!target)throw new Error("GOVERNANCE_SAFE address is required");const governanceSafe=getAddress(target),provider=rpc();await requireMainnet(provider);
    const deployer=deployerWallet(provider);confirm("timelock",deployer.address,governanceSafe.slice(2,10).toLowerCase());
    if(await provider.getCode(governanceSafe)==="0x")throw new Error("governance Safe has no code on Base mainnet");
    const item=artifact("RFQTimelock"),contract=await new ContractFactory(item.abi,item.bytecode,deployer).deploy(governanceSafe);const receipt=await contract.deploymentTransaction()!.wait(2);
    if(!receipt||receipt.status!==1)throw new Error("timelock deployment failed");const timelock=getAddress(receipt.contractAddress!);
    writePrivate(resolve(STATE,"timelock.json"),{chainId:"8453",timelock,governanceSafe,transaction:receipt.hash,gasUsed:receipt.gasUsed.toString(),deployedAt:new Date().toISOString()});
    writePrivate(resolve(STATE,"safe-batches/0-renounce-timelock-admin.json"),renounceTimelockAdminBatch("8453",timelock,governanceSafe));
    console.log(JSON.stringify({timelock,transaction:receipt.hash,next:"Import safe-batches/0-renounce-timelock-admin.json into the governance Safe and execute it, then set governance to this timelock in the manifest."},null,2));break;
  }
  case "deploy":{
    const manifest=loadManifest(),provider=rpc(),deployer=deployerWallet(provider);
    if(existsSync(RECORD))throw new Error(`${RECORD} already exists; this candidate is already deployed`);
    const evidenceIndex=flags.indexOf("--release-evidence"),dormant=flags.includes("--dormant");
    if((evidenceIndex>=0)===dormant)throw new Error("choose exactly one launch profile: --dormant or --release-evidence FILE");
    if(evidenceIndex>=0)checkReleaseEvidence(JSON.parse(readFileSync(resolve(flags[evidenceIndex+1]??""),"utf8")));
    const report=await preflight(provider,manifest,deployer.address);console.error(JSON.stringify({preflight:report},null,2));
    confirm("deploy",deployer.address,manifest.candidateHash.slice(0,12));
    const resume=existsSync(PARTIAL)?JSON.parse(readFileSync(PARTIAL,"utf8")):undefined;
    const record=await deployCore(deployer,manifest,{candidateHash:manifest.candidateHash,launchProfile:dormant?"dormant":"released",resume,onStep:(step,address,partial)=>{writePrivate(PARTIAL,partial);console.error(`${step}: ${address}`);}});
    writePrivate(RECORD,record);
    const batches=launchBatches(record,manifest);for(const [index,name] of (["emergencyPause","governanceSchedule","governanceConfigure","governanceGoLive"] as const).entries())writePrivate(resolve(STATE,`safe-batches/${index+1}-${name}.json`),batches[name]);
    console.log(JSON.stringify({record,operations:batches.operations,next:"Execute safe-batches/1-emergencyPause.json from the emergency Safe now, then run verify."},null,2));break;
  }
  case "verify":{
    const manifest=loadManifest(),record=loadRecord(),results=[];
    // The release checklist requires two independent RPCs; the secondary is optional only for a first look.
    for(const name of ["RFQ_BASE_MAINNET_RPC_URL","RFQ_BASE_MAINNET_SECONDARY_RPC_URL"])if(process.env[name]){const provider=rpc(name);await requireMainnet(provider);results.push({rpc:new URL(env(name)).hostname,...await verifyDeployment(provider,record,manifest)});}
    if(results.length<2)console.error("warning: only one RPC verified; set RFQ_BASE_MAINNET_SECONDARY_RPC_URL to an independent provider");
    console.log(JSON.stringify(results,null,2));break;
  }
  case "batches":{
    const manifest=loadManifest(),record=loadRecord(),batches=launchBatches(record,manifest);
    for(const [index,name] of (["emergencyPause","governanceSchedule","governanceConfigure","governanceGoLive"] as const).entries())writePrivate(resolve(STATE,`safe-batches/${index+1}-${name}.json`),batches[name]);
    console.log(JSON.stringify(batches.operations,null,2));break;
  }
  case "basescan":{
    // Publishes verified source to Basescan through the Etherscan v2 API.
    const manifest=loadManifest(),record=loadRecord(),apiKey=env("RFQ_BASESCAN_API_KEY"),api="https://api.etherscan.io/v2/api?chainid=8453";
    for(const item of basescanSubmissions(record,manifest)){
      const body=new URLSearchParams({apikey:apiKey,module:"contract",action:"verifysourcecode",contractaddress:item.address,sourceCode:JSON.stringify(item.input),codeformat:"solidity-standard-json-input",contractname:item.contractName,compilerversion:item.compilerVersion,constructorArguements:item.constructorArguments});
      const submitted=await (await fetch(api,{method:"POST",body})).json() as {status:string;result:string};
      if(submitted.status!=="1"&&!/already verified/i.test(submitted.result)){console.error(`${item.step}: ${submitted.result}`);process.exitCode=1;continue;}
      let result=submitted.result;
      for(let attempt=0;attempt<20&&submitted.status==="1";attempt++){await new Promise(done=>setTimeout(done,3_000));const status=await (await fetch(`${api}&module=contract&action=checkverifystatus&guid=${submitted.result}&apikey=${apiKey}`)).json() as {result:string};result=status.result;if(!/pending/i.test(result))break;}
      console.log(`${item.step} ${item.address}: ${result}`);if(!/pass|verified/i.test(result))process.exitCode=1;
    }
    break;
  }
  default:throw new Error("usage: base-mainnet-cli candidate|preflight|deploy-timelock|deploy|verify|batches|basescan ...");
}
