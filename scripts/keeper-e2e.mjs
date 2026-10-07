import {buildKeeper} from '../services/keeper/src/server.ts';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {buildApprover} from "../services/approver/src/server.ts";
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {network} from 'hardhat';
import {JsonRpcProvider} from 'ethers';
import {buildApi} from '../services/api/src/server.ts';
import {approvalTypes} from '../packages/shared/src/eip712.ts';
import {deployLinked,deploySignedOracle,launchMarkets,signedOracleReport} from './lib/contract-fixture.mjs';
const {ethers}=await network.create({network:'hardhatOp',chainType:'op'}),[governance,emergency,a,b,c,maker,user]=await ethers.getSigners(),libraries={};
const artifact=name=>JSON.parse(fs.readFileSync(`artifacts/${name}.json`,'utf8')),deploy=(name,args=[])=>deployLinked(governance,name,args,libraries);
const risk=await deploy('RFQRiskMath'),signatures=await deploy('RFQSignatureVerifier');libraries.RFQRiskMath=await risk.getAddress();libraries.RFQSignatureVerifier=await signatures.getAddress();
const token=await deploy('MockUSDC'),implementation=await deploy('RFQClearing'),oracleNodes=[0,1,2].map(()=>ethers.Wallet.createRandom()),adapter=await deploySignedOracle(governance,governance,oracleNodes,{libraries});
const init=new ethers.Interface(artifact('RFQClearing').abi).encodeFunctionData('initialize',[await token.getAddress(),await adapter.getAddress(),governance.address,emergency.address,[a.address,b.address,c.address],600_000_000_000n,launchMarkets()]),proxy=await deploy('TestProxy',[await implementation.getAddress(),governance.address,init]),clearing=new ethers.Contract(await proxy.getAddress(),artifact('RFQClearing').abi,governance);await (await clearing.unpause()).wait();await (await adapter.setClearing(await proxy.getAddress())).wait();
await (await token.mint(maker.address,1_000_000_000_000n)).wait();await (await token.connect(maker).approve(await proxy.getAddress(),ethers.MaxUint256)).wait();await (await clearing.connect(maker).fundMaker(800_000_000_000n)).wait();await (await clearing.connect(maker).fundInsurance(200_000_000_000n)).wait();
await (await token.mint(user.address,4_000_000_000n)).wait();await (await token.connect(user).approve(await proxy.getAddress(),ethers.MaxUint256)).wait();await (await clearing.connect(user).deposit(4_000_000_000n)).wait();
const prices=[100_000_000_000n,4_000_000_000n];
async function oracle(market){const index=market==='BTC'?0:1,block=await ethers.provider.getBlock('latest');return {snapshot:{market,bid:prices[index],ask:prices[index],observedAtMs:Date.now(),source:'signed'},report:await signedOracleReport({adapter,chainId:(await ethers.provider.getNetwork()).chainId,nodes:oracleNodes,observedAt:block.timestamp,prices:{market:index,bid:prices[index]}}),validUntil:block.timestamp+15};}
for(const market of ['BTC','ETH']){const observation=await oracle(market);await (await clearing.refreshOracle(observation.report)).wait();}
class Chain extends JsonRpcProvider {async send(method,params){return ethers.provider.send(method,params);}async getNetwork(){return ethers.provider.getNetwork();}async getBlockNumber(){return ethers.provider.getBlockNumber();}async getBlock(tag){return ethers.provider.getBlock(tag);}async call(request){return ethers.provider.call(request);}}
const provider=new Chain(),sponsor=ethers.Wallet.createRandom();await (await governance.sendTransaction({to:sponsor.address,value:ethers.parseEther('1')})).wait();
const domainChainId=(await ethers.provider.getNetwork()).chainId,proxyAddress=await proxy.getAddress();
const approverApps=[a,b,c].map((signer,index)=>{const key=ethers.HDNodeWallet.fromPhrase('test test test test test test test test test test test junk',undefined,`m/44'/60'/0'/0/${index+2}`);assert.equal(key.address,signer.address);return buildApprover({provider,privateKey:key.privateKey,transportToken:'private',databasePath:':memory:',expectedChainId:domainChainId,expectedVerifyingContract:proxyAddress,oracleMode:'signed'});});
let approvals=0;
const app=buildApi({provider,chainId:(await ethers.provider.getNetwork()).chainId,verifyingContract:await proxy.getAddress(),chain:{rpcUrl:'http://127.0.0.1:8545',sponsorPrivateKey:sponsor.privateKey,clearingAddress:await proxy.getAddress(),tokenAddress:await token.getAddress()},oracleSource:{latest:oracle},approvers:[a,b,c].map((signer,index)=>({url:`http://approver-${index}`,token:'private'})),fetchImpl:async(url,request)=>{const index=Number(String(url).match(/approver-(\d)/)[1]),payload=JSON.parse(request.body);approvals++;const response=await approverApps[index].inject({method:'POST',url:'/approve',headers:{authorization:'Bearer private'},payload});return new Response(response.body,{status:response.statusCode});},sender:{reconcile:async()=>{},status:()=>[],submit:async(_id,request)=>{const tx=await governance.sendTransaction(request),receipt=await tx.wait();return {hash:receipt.hash,blockNumber:receipt.blockNumber,blockHash:receipt.blockHash,status:1};}}});
async function post(url,payload){const response=await app.inject({method:'POST',url,payload});assert.equal(response.statusCode,200,response.body);return response.json();}

const directory=mkdtempSync(join(tmpdir(),'rfq-keeper-e2e-'));
let keeper;
async function runKeeper(name){
 const key=ethers.HDNodeWallet.fromPhrase('test test test test test test test test test test test junk',undefined,`m/44'/60'/0'/0/${name==='liquidation'?8:9}`);
 const keeperProvider=new Chain();
 keeper=buildKeeper({provider:keeperProvider,rpcUrl:'http://127.0.0.1:8545',chainId:domainChainId,clearingAddress:proxyAddress,tokenAddress:await token.getAddress(),sponsorKey:key.privateKey,databasePath:join(directory,`${name}.sqlite`),indexerUrl:'http://independent-indexer',operationsToken:'private-keeper',pollMs:1_000_000,budget:{dailyBudgetWei:ethers.parseEther('1'),maxFeePerGas:ethers.parseUnits('100','gwei'),maxGasLimit:2_000_000n,maxValue:100n,firstWaitMs:1000,maxReplacements:0},oracleSource:{latest:async market=>{const result=await oracle(market),block=await ethers.provider.getBlock('latest');result.snapshot.observedAtMs=(block.timestamp-1)*1000;return result;}},fetchImpl:async url=>{
  const path=new URL(url).pathname;
  if(path==='/health')return Response.json({ok:true,lag:0});
  assert.equal(path,'/v1/positions');const size=(await clearing.positionOf(user.address,0)).size;
  return Response.json({items:size===0n?[]:[{account:user.address,positions:{BTC:{size:String(size)},ETH:{size:'0'}}}],nextCursor:null});
 }});
 await keeper.ready();const health=await keeper.inject('/health');assert.equal(health.json().ok,true,health.body);
 const metrics=await keeper.inject({url:'/internal/metrics',headers:{authorization:'Bearer private-keeper'}});assert.equal(metrics.statusCode,200);
 assert.equal((await keeper.inject('/internal/metrics')).statusCode,401);
 await keeper.close();keeper=undefined;keeperProvider.destroy();
}
try{
 await app.ready();const quote=await post('/v1/quote',{market:'BTC',side:'buy',amount:'10000'}),prepared=await post('/v1/prepare',{quoteId:quote.quoteId,account:user.address,nonce:'700'}),signature=await user.signTypedData(prepared.domain,prepared.types,prepared.intent);
 await post('/v1/approve',{quoteId:quote.quoteId,account:user.address,nonce:'700',userSignature:signature});
 await app.close();for(const approver of approverApps)await approver.close();
 const snapshot=await ethers.provider.send('evm_snapshot',[]);
 prices[0]=50_000_000_000n;await ethers.provider.send('evm_increaseTime',[10]);await ethers.provider.send('evm_mine',[]);
 await runKeeper('liquidation');assert.equal((await clearing.positionOf(user.address,0)).size,0n);assert.equal(await clearing.resolutionRequired(),false);
 const liquidationDb=new DatabaseSync(join(directory,'liquidation.sqlite'));const raw=liquidationDb.prepare('SELECT raw_tx FROM sender_transactions WHERE operation_id LIKE ?').all('keeper:%');// BTC refresh and liquidation; ETH has no open interest, so the keeper no longer refreshes it.
 assert(raw.length>=2);for(const row of raw)assert.equal(ethers.Transaction.from(row.raw_tx).value,0n);liquidationDb.close();
 await runKeeper('liquidation');assert.equal((await clearing.positionOf(user.address,0)).size,0n);
 await ethers.provider.send('evm_revert',[snapshot]);prices[0]=10_000_000_000_000n;await (await clearing.pause()).wait();const incident=await oracle('BTC');await (await clearing.connect(user).closePosition(0,incident.report)).wait();assert.equal(await clearing.resolutionRequired(),true);
 await runKeeper('resolution');assert.equal(await clearing.resolutionSampleCount(0),1n);assert.equal(await clearing.resolutionSampleCount(1),0n,'ETH has no open exposure, so it needs no resolution samples');
 await ethers.provider.send('evm_increaseTime',[15]);await ethers.provider.send('evm_mine',[]);await runKeeper('resolution');assert.equal(await clearing.resolutionSampleCount(0),2n);
 await ethers.provider.send('evm_increaseTime',[30]);await ethers.provider.send('evm_mine',[]);await runKeeper('resolution');assert.equal(await clearing.resolutionPricesReady(),true);
 await runKeeper('resolution');assert.equal(await clearing.resolutionFinalized(),true);assert((await clearing.resolutionClaim(user.address))>0n);
 await runKeeper('resolution');
 console.log('Independent keeper E2E passed: API stopped, signed oracle reports, cross-margin bankruptcy, persistent sponsor restart, post-trigger sampling and bounded resolution');
}finally{if(keeper)await keeper.close();await app.close();for(const approver of approverApps)await approver.close();rmSync(directory,{recursive:true,force:true});}
