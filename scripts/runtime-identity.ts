import {Contract,getAddress,keccak256,type JsonRpcProvider} from 'ethers';
export interface RuntimeIdentity {
 chainId:bigint;clearingAddress:string;tokenAddress:string;oracleAddress:string;oracleSource:string;governance:string;emergencyCouncil:string;feedIds:[string,string];approvers:[string,string,string];
 code:Array<{address:string;hash:string}>;
 implementationAddress:string;
 riskMathAddress:string;signatureVerifierAddress:string;
}
const IMPLEMENTATION_SLOT='0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';
/** Both independent RPCs must attest to one pinned block and the reviewed authority/feed/code identity. */
export async function validateRuntimeIdentity(primary:JsonRpcProvider,secondary:JsonRpcProvider,expected:RuntimeIdentity){
 const address=getAddress(expected.clearingAddress),tag=Number(BigInt(await primary.send('eth_blockNumber',[]))),[network,otherNetwork,block,otherBlock]=await Promise.all([primary.getNetwork(),secondary.getNetwork(),primary.getBlock(tag),secondary.getBlock(tag)]);
 if(network.chainId!==expected.chainId||otherNetwork.chainId!==expected.chainId||!block?.hash||block.hash!==otherBlock?.hash)throw new Error('runtime RPC chain/block identity mismatch');
 const normalized=expected.code.map(item=>({address:getAddress(item.address),hash:item.hash.toLowerCase()})),required=[address,expected.tokenAddress,expected.oracleAddress,expected.oracleSource,expected.implementationAddress,expected.riskMathAddress,expected.signatureVerifierAddress].map(getAddress);
 if(new Set(normalized.map(item=>item.address)).size!==normalized.length||required.some(item=>!normalized.some(code=>code.address===item))||normalized.some(item=>!/^0x[0-9a-f]{64}$/.test(item.hash)))throw new Error('runtime code identity manifest incomplete');
 if(new Set([...expected.approvers,expected.governance,expected.emergencyCouncil].map(getAddress)).size!==5||new Set(expected.feedIds.map(feed=>feed.toLowerCase())).size!==2)throw new Error('runtime authorities/approvers/feeds must be distinct');
 for(const provider of [primary,secondary]){
  const clearing=new Contract(address,['function usdc() view returns(address)','function oracle() view returns(address)','function governance() view returns(address)','function emergencyCouncil() view returns(address)','function approvers(uint256) view returns(address)'],provider),adapter=new Contract(expected.oracleAddress,['function pyth() view returns(address)','function clearing() view returns(address)','function feedIds(uint256) view returns(bytes32)'],provider),token=new Contract(expected.tokenAddress,['function decimals() view returns(uint8)'],provider),opts={blockTag:tag};
  const [implementation,usdc,oracle,governance,emergency,source,adapterClearing,decimals,...rest]=await Promise.all([provider.getStorage(address,IMPLEMENTATION_SLOT,tag),clearing.usdc(opts),clearing.oracle(opts),clearing.governance(opts),clearing.emergencyCouncil(opts),adapter.pyth(opts),adapter.clearing(opts),token.decimals(opts),adapter.feedIds(0,opts),adapter.feedIds(1,opts),clearing.approvers(0,opts),clearing.approvers(1,opts),clearing.approvers(2,opts)]);
  const same=(actual:string,wanted:string)=>getAddress(actual)===getAddress(wanted);
  if(!same(`0x${String(implementation).slice(-40)}`,expected.implementationAddress)||!same(usdc,expected.tokenAddress)||!same(oracle,expected.oracleAddress)||!same(governance,expected.governance)||!same(emergency,expected.emergencyCouncil)||!same(source,expected.oracleSource)||!same(adapterClearing,address)||decimals!==6n)throw new Error('runtime contract/token/authority identity mismatch');
  for(let i=0;i<2;i++)if(String(rest[i]).toLowerCase()!==expected.feedIds[i].toLowerCase())throw new Error('runtime oracle feed mismatch');
  for(let i=0;i<3;i++)if(!same(rest[i+2],expected.approvers[i]))throw new Error('runtime approver identity mismatch');
  const actual=await Promise.all(normalized.map(async item=>({item,code:await provider.getCode(item.address,tag)})));if(actual.some(({item,code})=>code==='0x'||keccak256(code)!==item.hash))throw new Error('runtime deployed bytecode identity mismatch');
  const implementationCode=actual.find(({item})=>item.address===getAddress(expected.implementationAddress))!.code.toLowerCase();if([expected.riskMathAddress,expected.signatureVerifierAddress].some(link=>!implementationCode.includes(link.slice(2).toLowerCase())))throw new Error('runtime implementation linked-module mismatch');
 }
 return {block:tag,hash:block.hash};
}
