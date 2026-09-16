import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {getAddress} from 'ethers';
import {z} from 'zod';
import {identifyCandidate} from './candidate-identity.js';

const address=z.string().regex(/^0x[0-9a-fA-F]{40}$/).transform(getAddress),hash=z.string().regex(/^[a-f0-9]{64}$/),feed=z.string().regex(/^0x[0-9a-fA-F]{64}$/),amount=z.string().regex(/^[1-9][0-9]*$/).transform(BigInt);
const market=z.object({enabled:z.literal(true),maxTradeUsdc:amount,grossUsdc:amount,sideUsdc:amount,netUsdc:amount,hedgeBandUsdc:amount}).strict();
export const mainnetManifestSchema=z.object({
 version:z.literal(1),mode:z.literal('capped-canary'),chainId:z.literal('8453'),candidateHash:hash,
 usdc:address,oracleSource:address,feedIds:z.tuple([feed,feed]),governance:address,emergencyCouncil:address,approvers:z.tuple([address,address,address]),
 policy:z.object({makerCapitalUsdc:amount,insuranceCapitalUsdc:amount,dailyLossLimitUsdc:amount,timelockSeconds:z.number().int().min(259200),markets:z.object({BTC:market,ETH:market}).strict()}).strict(),
}).strict();

export function validateMainnetManifest(input:unknown){
 const value=mainnetManifestSchema.parse(input),officialBaseUsdc=getAddress('0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913');
 if(value.usdc!==officialBaseUsdc)throw new Error('Base mainnet USDC address mismatch');
 const roles=[value.usdc,value.oracleSource,value.governance,value.emergencyCouncil,...value.approvers];if(new Set(roles.map(item=>item.toLowerCase())).size!==roles.length)throw new Error('Mainnet roles must be distinct');
 if(value.feedIds[0].toLowerCase()===value.feedIds[1].toLowerCase())throw new Error('Mainnet feed IDs must differ');
 if(value.policy.insuranceCapitalUsdc*4n<value.policy.makerCapitalUsdc)throw new Error('Insurance capital must be at least 25% of maker capital');
 if(value.policy.dailyLossLimitUsdc*20n>value.policy.makerCapitalUsdc)throw new Error('Daily loss limit must be at most 5% of maker capital');
 for(const [name,item] of Object.entries(value.policy.markets)){if(item.maxTradeUsdc*10n>item.grossUsdc||item.sideUsdc>item.grossUsdc||item.netUsdc>item.grossUsdc||item.hedgeBandUsdc*20n>item.grossUsdc)throw new Error(`${name} canary limits are not conservative`);}
 return value;
}

export function createMainnetDeploymentPlan(input:unknown,root=process.cwd()){
 const manifest=validateMainnetManifest(input),candidate=identifyCandidate(root);if(candidate.candidateHash!==manifest.candidateHash)throw new Error('Mainnet manifest does not match the current candidate');
 return {version:1,kind:'unsigned-mainnet-deployment-plan',candidateHash:candidate.candidateHash,chainId:manifest.chainId,mode:manifest.mode,preconditions:['release-evidence-v2 passes','independent contracts/services/operations reviews match candidate','72-hour soak matches candidate and deployment','governance and emergency Safe ceremony complete','deployer balance and nonce reviewed immediately before execution'],deploymentOrder:['RFQRiskMath','RFQSignatureVerifier','RFQClearing implementation','PythCoreAdapter','TransparentUpgradeableProxy'],initialization:{usdc:manifest.usdc,oracleSource:manifest.oracleSource,governance:manifest.governance,emergencyCouncil:manifest.emergencyCouncil,approvers:manifest.approvers,makerCapitalUsdc:manifest.policy.makerCapitalUsdc.toString()},policy:{...manifest.policy,makerCapitalUsdc:manifest.policy.makerCapitalUsdc.toString(),insuranceCapitalUsdc:manifest.policy.insuranceCapitalUsdc.toString(),dailyLossLimitUsdc:manifest.policy.dailyLossLimitUsdc.toString(),markets:Object.fromEntries(Object.entries(manifest.policy.markets).map(([name,item])=>[name,Object.fromEntries(Object.entries(item).map(([key,value])=>[key,typeof value==='bigint'?value.toString():value]))]))},executionAuthorized:false};
}

if(process.argv[1]&&resolve(process.argv[1])===resolve(new URL(import.meta.url).pathname)){
 const source=process.argv[2],output=process.argv[3];if(!source||!output)throw new Error('Usage: mainnet-manifest MANIFEST_JSON OUTPUT_PLAN_JSON');if(existsSync(output))throw new Error('Deployment plan destination already exists');const plan=createMainnetDeploymentPlan(JSON.parse(readFileSync(source,'utf8')));writeFileSync(output,JSON.stringify(plan,null,2)+'\n',{mode:0o600});
}
