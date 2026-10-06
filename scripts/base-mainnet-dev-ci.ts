import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { Contract, HDNodeWallet, JsonRpcProvider, Mnemonic, Wallet, formatEther, getAddress, parseEther, parseUnits } from "ethers";
import { generateDevIdentities } from "./base-mainnet-dev.js";
import { artifact, type DeploymentRecord } from "./base-mainnet.js";
import { identifyCandidate } from "./candidate-identity.js";
import { validateDevManifest } from "./mainnet-manifest.js";

// GitHub Actions driver for the Base mainnet dev profile (.github/workflows/dev-contracts.yml).
// Every role key is derived from one recovery phrase held as the RFQ_DEV_MNEMONIC environment secret,
// so the owner is account 1 in any wallet app restored from that phrase. The workflow runs in a GitHub
// environment with required reviewers; that approval replaces the CLI's typed confirmation string.
//   identities                     public addresses only
//   prepare                        writes identities and the dev manifest into the dev state directory
//   cli ACTION [FLAGS]             runs a base-mainnet-cli dev-* action with its confirmation set
//   fund-maker USDC                owner approves and deposits maker capital
//   fund-sponsor ETH               owner tops the gas sponsor up to ETH
//   unpause                        owner unpauses the clearing
//   runtime-secrets                JSON for the Cloudflare runtime secret (pipe straight into wrangler)
export const DEV_ROLE_INDEX={owner:0,emergency:1,approvers:[2,3,4],sponsor:5} as const;
export const PYTH_CORE_BASE_MAINNET="0x8250f4aF4B972684F7b336503E2D6dFeDeB1487a";
const BASE_USDC="0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

export function deriveDevIdentities(phrase:string){
  const mnemonic=Mnemonic.fromPhrase(phrase.trim());
  const at=(index:number)=>{const wallet=HDNodeWallet.fromMnemonic(mnemonic,`m/44'/60'/0'/0/${index}`);return {address:wallet.address,privateKey:wallet.privateKey};};
  return {owner:at(DEV_ROLE_INDEX.owner),emergency:at(DEV_ROLE_INDEX.emergency),approvers:DEV_ROLE_INDEX.approvers.map(at) as [ReturnType<typeof at>,ReturnType<typeof at>,ReturnType<typeof at>],sponsor:at(DEV_ROLE_INDEX.sponsor)};
}

/** The raw dev manifest for derived identities, validated; `policy` overrides the defaults and is still bound by the dev ceilings. */
export function devManifestFor(identities:ReturnType<typeof deriveDevIdentities>,oracleSource:string,policy?:unknown){
  const base=generateDevIdentities(getAddress(oracleSource)).manifest;
  const manifest={...base,owner:identities.owner.address,emergencyCouncil:identities.emergency.address,approvers:identities.approvers.map(item=>item.address),...(policy?{policy:policy as typeof base.policy}:{})};
  validateDevManifest(manifest);
  return manifest;
}

/** Confirmation string base-mainnet-cli expects for a dev action. */
export function devConfirmation(action:string,owner:string,record?:DeploymentRecord){
  const suffix=action==="dev-configure"?record!.contracts.clearingProxy.slice(2,10).toLowerCase():identifyCandidate().candidateHash.slice(0,12);
  return `${action}-8453-${owner.toLowerCase()}-${suffix}`;
}

const STATE=resolve(process.env.RFQ_MAINNET_DEV_STATE_DIR??".local-state/base-mainnet-dev"),RECORD=resolve(STATE,"deployment.json"),MANIFEST=resolve(STATE,"dev-manifest.json");
const env=(name:string)=>{const value=process.env[name];if(!value)throw new Error(`${name} is required`);return value;};
const writePrivate=(path:string,value:unknown)=>{mkdirSync(dirname(path),{recursive:true});writeFileSync(path,JSON.stringify(value,null,2)+"\n",{mode:0o600});chmodSync(path,0o600);};
const rpcUrl=()=>process.env.RFQ_BASE_MAINNET_RPC_URL||"https://mainnet.base.org";
async function ownerWallet(){
  const provider=new JsonRpcProvider(rpcUrl());const chainId=(await provider.getNetwork()).chainId;if(chainId!==8453n)throw new Error(`expected Base mainnet 8453, RPC reports ${chainId}`);
  return new Wallet(deriveDevIdentities(env("RFQ_DEV_MNEMONIC")).owner.privateKey,provider);
}
const loadRecord=()=>{if(!existsSync(RECORD))throw new Error("no dev deployment yet; run the deploy action first");return JSON.parse(readFileSync(RECORD,"utf8")) as DeploymentRecord;};

if(import.meta.url===`file://${process.argv[1]}`){
  const [command,...args]=process.argv.slice(2);
  switch(command){
    case "identities":{
      const identities=deriveDevIdentities(env("RFQ_DEV_MNEMONIC"));
      console.log(JSON.stringify({owner:identities.owner.address,emergency:identities.emergency.address,approvers:identities.approvers.map(item=>item.address),sponsor:identities.sponsor.address},null,2));break;
    }
    case "prepare":{
      const identities=deriveDevIdentities(env("RFQ_DEV_MNEMONIC"));
      const policy=process.env.RFQ_DEV_POLICY_JSON?JSON.parse(process.env.RFQ_DEV_POLICY_JSON):undefined;
      const manifest=devManifestFor(identities,process.env.RFQ_PYTH_CORE_ADDRESS||PYTH_CORE_BASE_MAINNET,policy);
      writePrivate(resolve(STATE,"identities.json"),{owner:identities.owner,emergency:identities.emergency,approvers:identities.approvers});
      writePrivate(MANIFEST,manifest);
      console.log(`prepared dev manifest for owner ${identities.owner.address}`);break;
    }
    case "cli":{
      const [action,...flags]=args;if(!action?.startsWith("dev-"))throw new Error("cli ACTION must be a dev-* action");
      const owner=deriveDevIdentities(env("RFQ_DEV_MNEMONIC")).owner.address;
      const confirmation=devConfirmation(action,owner,action==="dev-configure"?loadRecord():undefined);
      execFileSync(process.execPath,["--import","tsx","scripts/base-mainnet-cli.ts",action,MANIFEST,...flags],{stdio:"inherit",env:{...process.env,RFQ_BASE_MAINNET_RPC_URL:rpcUrl(),RFQ_MAINNET_DEPLOY_CONFIRM:confirmation,RFQ_MAINNET_DEPLOYER_KEY:""}});break;
    }
    case "fund-maker":{
      const owner=await ownerWallet(),record=loadRecord(),amount=parseUnits(args[0]??"100",6);
      const usdc=new Contract(BASE_USDC,artifact("MockUSDC").abi,owner),clearing=new Contract(record.contracts.clearingProxy,artifact("RFQClearing").abi,owner);
      if(await usdc.balanceOf(owner.address)<amount)throw new Error(`owner ${owner.address} holds less than ${args[0]??"100"} USDC`);
      await (await usdc.approve(record.contracts.clearingProxy,amount)).wait(2);await (await clearing.fundMaker(amount)).wait(2);
      console.log(`maker capital now ${await clearing.makerBacking()} (6-decimal USDC)`);break;
    }
    case "fund-sponsor":{
      const owner=await ownerWallet(),sponsor=deriveDevIdentities(env("RFQ_DEV_MNEMONIC")).sponsor.address,target=parseEther(args[0]??"0.003"),balance=await owner.provider!.getBalance(sponsor);
      if(balance<target)await (await owner.sendTransaction({to:sponsor,value:target-balance})).wait(2);
      console.log(`sponsor ${sponsor} holds ${formatEther(await owner.provider!.getBalance(sponsor))} ETH`);break;
    }
    case "unpause":{
      const owner=await ownerWallet(),clearing=new Contract(loadRecord().contracts.clearingProxy,artifact("RFQClearing").abi,owner);
      if(await clearing.paused())await (await clearing.unpause()).wait(2);console.log("clearing unpaused");break;
    }
    case "runtime-secrets":{
      const identities=deriveDevIdentities(env("RFQ_DEV_MNEMONIC"));
      process.stdout.write(JSON.stringify({rpcUrl:rpcUrl(),secondaryRpcUrl:process.env.RFQ_BASE_MAINNET_SECONDARY_RPC_URL||rpcUrl(),pythApiKey:env("PYTH_API_KEY"),sponsorKey:identities.sponsor.privateKey,approverKeys:identities.approvers.map(item=>item.privateKey)}));break;
    }
    default:throw new Error("usage: base-mainnet-dev-ci identities|prepare|cli ACTION|fund-maker USDC|fund-sponsor ETH|unpause|runtime-secrets");
  }
}
