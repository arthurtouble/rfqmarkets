import {readFileSync} from 'node:fs';
import {Contract,JsonRpcProvider,keccak256,getAddress} from 'ethers';
import {validateRuntimeIdentity,type RuntimeIdentity} from './runtime-identity.js';
const primaryUrl=process.env.RFQ_RPC_URL??process.env.RFQ_BASE_SEPOLIA_RPC_URL;
if(!process.argv[2]||!primaryUrl||!process.env.RFQ_SECONDARY_RPC_URL)throw new Error('Supply a deployment manifest and two independent RPC URLs (RFQ_RPC_URL, RFQ_SECONDARY_RPC_URL)');
const deployment=JSON.parse(readFileSync(process.argv[2],'utf8')),contracts=deployment.contracts;
const primary=new JsonRpcProvider(primaryUrl,undefined,{batchMaxCount:1}),secondary=new JsonRpcProvider(process.env.RFQ_SECONDARY_RPC_URL,undefined,{batchMaxCount:1});
try{
 const block=await primary.getBlockNumber(),chainId=(await primary.getNetwork()).chainId;
 if(String(chainId)!==String(deployment.chainId))throw new Error('RPC chain does not match the deployment manifest');
 const adapter=new Contract(contracts.oracleAdapter,['function signers() view returns(address[])','function threshold() view returns(uint8)'],primary);
 const identity:RuntimeIdentity={chainId,clearingAddress:contracts.clearingProxy,tokenAddress:contracts.usdc,oracleAddress:contracts.oracleAdapter,oracleSigners:Array.from(await adapter.signers({blockTag:block}) as string[],getAddress),oracleThreshold:Number(await adapter.threshold({blockTag:block})),governance:deployment.governance,emergencyCouncil:deployment.emergencyCouncil,approvers:deployment.approvers,implementationAddress:contracts.clearingImplementation,riskMathAddress:contracts.riskMath??contracts.libraries?.RFQRiskMath,signatureVerifierAddress:contracts.signatureVerifier??contracts.libraries?.RFQSignatureVerifier,code:[]};
 for(const address of [...new Set([identity.clearingAddress,identity.tokenAddress,identity.oracleAddress,identity.implementationAddress,identity.riskMathAddress,identity.signatureVerifierAddress].map(getAddress))]){const code=await primary.getCode(address,block);if(code==='0x')throw new Error('Observed runtime identity contains missing code');identity.code.push({address,hash:keccak256(code)});}
 const checkpoint=await validateRuntimeIdentity(primary,secondary,identity);const {chainId:_chain,clearingAddress,tokenAddress,...runtimeIdentity}=identity;
 console.log(JSON.stringify({status:'observed_requires_independent_review',checkpoint,chainId:String(chainId),clearingAddress,tokenAddress,runtimeIdentity},null,2));
}finally{primary.destroy();secondary.destroy();}
