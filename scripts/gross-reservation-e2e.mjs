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
import {MAX_MARKET_CONFIG,deployLinked} from './lib/contract-fixture.mjs';
const {ethers}=await network.create({network:'hardhatOp',chainType:'op'}),[governance,emergency,a,b,c,maker,user]=await ethers.getSigners(),libraries={};
const artifact=name=>JSON.parse(fs.readFileSync(`artifacts/${name}.json`,'utf8')),deploy=(name,args=[])=>deployLinked(governance,name,args,libraries);
const risk=await deploy('RFQRiskMath'),signatures=await deploy('RFQSignatureVerifier');libraries.RFQRiskMath=await risk.getAddress();libraries.RFQSignatureVerifier=await signatures.getAddress();
const token=await deploy('MockUSDC'),core=await deploy('MockPythCore'),implementation=await deploy('RFQClearing'),feeds=[ethers.id('BTC'),ethers.id('ETH')],predicted=ethers.getCreateAddress({from:governance.address,nonce:(await governance.getNonce('pending'))+1}),adapter=await deploy('PythCoreAdapter',[await core.getAddress(),predicted,feeds]);
const init=new ethers.Interface(artifact('RFQClearing').abi).encodeFunctionData('initialize',[await token.getAddress(),await adapter.getAddress(),governance.address,emergency.address,[a.address,b.address,c.address],600_000_000_000n,[MAX_MARKET_CONFIG,MAX_MARKET_CONFIG]]),proxy=await deploy('TestProxy',[await implementation.getAddress(),governance.address,init]),clearing=new ethers.Contract(await proxy.getAddress(),artifact('RFQClearing').abi,governance);await (await clearing.unpause()).wait();assert.equal(await proxy.getAddress(),predicted);
await (await core.setFee(7n)).wait();await (await token.mint(maker.address,950_000_000_000n)).wait();await (await token.connect(maker).approve(await proxy.getAddress(),ethers.MaxUint256)).wait();await (await clearing.connect(maker).fundMaker(800_000_000_000n)).wait();await (await clearing.connect(maker).fundInsurance(150_000_000_000n)).wait();
await (await token.mint(user.address,4_000_000_000n)).wait();await (await token.connect(user).approve(await proxy.getAddress(),ethers.MaxUint256)).wait();await (await clearing.connect(user).deposit(4_000_000_000n)).wait();
const prices=[100_000_000_000n,4_000_000_000n];
async function oracle(market){const index=market==='BTC'?0:1,block=await ethers.provider.getBlock('latest');await (await core.setPrice(feeds[index],[prices[index]*100n,0n,-8,block.timestamp])).wait();return {snapshot:{market,bid:prices[index],ask:prices[index],observedAtMs:Date.now(),source:'pyth'},report:ethers.AbiCoder.defaultAbiCoder().encode(['uint8','bytes[]'],[index,['0x1234']]),validUntil:block.timestamp+15};}
for(const market of ['BTC','ETH']){const observation=await oracle(market);await (await clearing.refreshOracle(observation.report,{value:7n})).wait();}

let finalized=false;
class Chain extends JsonRpcProvider {async send(method,params){if(method==='eth_getBlockByNumber'&&params[0]==='finalized')return ethers.provider.send(method,[finalized?'latest':'0x0',false]);return ethers.provider.send(method,params);}async getNetwork(){return ethers.provider.getNetwork();}async getBlockNumber(){return ethers.provider.getBlockNumber();}async getBlock(tag){return ethers.provider.getBlock(tag);}async call(request){return ethers.provider.call(request);}}
const other=(await ethers.getSigners())[7];await (await token.mint(other.address,4_000_000_000n)).wait();await (await token.connect(other).approve(await proxy.getAddress(),ethers.MaxUint256)).wait();await (await clearing.connect(other).deposit(4_000_000_000n)).wait();
await (await clearing.pause()).wait();await (await clearing.setExposurePolicy(0,20_000_000_000n,20_000_000_000n)).wait();await (await clearing.unpause()).wait();
const directory=mkdtempSync(join(tmpdir(),'rfq-gross-e2e-')),chainId=(await ethers.provider.getNetwork()).chainId,address=await proxy.getAddress(),sponsor=ethers.Wallet.createRandom();await (await governance.sendTransaction({to:sponsor.address,value:ethers.parseEther('1')})).wait();
const signerApps=[],apiApps=[];let requests=0,loseResponses=true;const rejected=[];
function makeSigner(index){const key=ethers.HDNodeWallet.fromPhrase('test test test test test test test test test test test junk',undefined,`m/44'/60'/0'/0/${index+2}`);const app=buildApprover({provider:new Chain(),privateKey:key.privateKey,transportToken:'private',databasePath:join(directory,`signer-${index}.sqlite`),expectedChainId:chainId,expectedVerifyingContract:address,oracleMode:'pyth'});signerApps[index]=app;return app;}
const apiPath=join(directory,'api.sqlite');
function makeApi(path=apiPath){const app=buildApi({provider:new Chain(),chainId,verifyingContract:address,journalPath:path,chain:{rpcUrl:'http://127.0.0.1:8545',sponsorPrivateKey:sponsor.privateKey,clearingAddress:address,tokenAddress:awaitTokenAddress},oracleSource:{latest:oracle},approvers:[a,b,c].map((_,i)=>({url:`http://approver-${i}`,token:'private'})),fetchImpl:async(url,request)=>{const index=Number(String(url).match(/approver-(\d)/)[1]);requests++;if(loseResponses&&index===2)throw new Error('third signer unavailable');const response=await signerApps[index].inject({method:'POST',url:'/approve',headers:{authorization:'Bearer private'},payload:JSON.parse(request.body)});if(loseResponses)throw new Error('signature response lost after durable commit');if(response.statusCode!==200)rejected.push({index,...response.json()});return new Response(response.body,{status:response.statusCode});},sender:{reconcile:async()=>{},status:()=>[],submit:async(_id,request)=>{const receipt=await (await governance.sendTransaction(request)).wait();return {hash:receipt.hash,blockNumber:receipt.blockNumber,blockHash:receipt.blockHash,status:1};}}});apiApps.push(app);return app;}
const awaitTokenAddress=await token.getAddress();
async function post(app,url,payload){const response=await app.inject({method:'POST',url,payload});assert.equal(response.statusCode,200,response.body);return response.json();}
async function requestTrade(app,account,side,amount,nonce){const quote=await post(app,'/v1/quote',{market:'BTC',side,amount}),prepared=await post(app,'/v1/prepare',{quoteId:quote.quoteId,account:account.address,nonce}),signature=await account.signTypedData(prepared.domain,prepared.types,prepared.intent);return app.inject({method:'POST',url:'/v1/approve',payload:{quoteId:quote.quoteId,account:account.address,nonce,userSignature:signature}});}
function read(path,sql){const db=new DatabaseSync(path);try{return db.prepare(sql).all();}finally{db.close();}}
try{
 for(let i=0;i<3;i++)await makeSigner(i).ready();let api=makeApi();await api.ready();
 const lost=await requestTrade(api,user,'buy','10000','501');assert.equal(lost.statusCode,503,lost.body);assert.equal((await clearing.positionOf(user.address,0)).size,0n);
 const artifacts=read(apiPath,'SELECT payload FROM approval_artifacts');assert.equal(artifacts.length,1);const payload=JSON.parse(artifacts[0].payload),sigA=read(join(directory,'signer-0.sqlite'),'SELECT signature FROM approvals')[0].signature,sigB=read(join(directory,'signer-1.sqlite'),'SELECT signature FROM approvals')[0].signature;
 assert.equal(read(apiPath,'SELECT * FROM gross_reservations').length,1);assert.equal(read(join(directory,'signer-0.sqlite'),'SELECT * FROM gross_reservations').length,1);
 const fork=await ethers.provider.send('evm_snapshot',[]);
 await (await clearing.executeTrade(payload.intent,payload.approval,payload.report,payload.userSignature,sigA,sigB,{value:7n})).wait();assert((await clearing.positionOf(user.address,0)).size>0n);assert.equal(read(apiPath,'SELECT * FROM gross_reservations').length,1,'inclusion must retain escaped capacity');
 await ethers.provider.send('evm_revert',[fork]);assert.equal((await clearing.positionOf(user.address,0)).size,0n,'fixture must orphan the included fill');
 await api.close();api=makeApi();await api.ready();loseResponses=false;const before=requests;
 const blocked=await requestTrade(api,other,'sell','11000','502');assert.equal(blocked.statusCode,409,blocked.body);assert.equal(requests,before,'restored API must reject before contacting signers');
 for(let i=0;i<3;i++){await signerApps[i].close();await makeSigner(i).ready();}
 const second=makeApi(join(directory,'second-api.sqlite'));await second.ready();const independent=await requestTrade(second,other,'sell','11000','503');assert.equal(independent.statusCode,503,independent.body);
 assert.equal(read(join(directory,'signer-0.sqlite'),'SELECT * FROM approvals').length,1,'first signer must reject overcommitment');assert.equal(read(join(directory,'signer-1.sqlite'),'SELECT * FROM approvals').length,1,'quorum intersection must reject overcommitment');assert.equal((await clearing.positionOf(other.address,0)).size,0n);
 assert.equal(read(join(directory,'signer-2.sqlite'),'SELECT * FROM approvals').length,1,'third signer may sign alone but cannot create quorum');
 assert(rejected.some(row=>row.index===0&&row.error==='independent outstanding gross, net, stress or capital capacity exceeded'));assert(rejected.some(row=>row.index===1&&row.error==='independent outstanding gross, net, stress or capital capacity exceeded'));
 // A compromised shared signer can bypass its local journal: test canonical safety, not Byzantine reservation coordination.
 const byzantineFork=await ethers.provider.send('evm_snapshot',[]),secondPayload=JSON.parse(read(join(directory,'second-api.sqlite'),'SELECT payload FROM approval_artifacts')[0].payload),sigC=read(join(directory,'signer-2.sqlite'),'SELECT signature FROM approvals')[0].signature,maliciousB=await b.signTypedData(secondPayload.domain,approvalTypes,secondPayload.approval);
 await (await clearing.executeTrade(payload.intent,payload.approval,payload.report,payload.userSignature,sigA,sigB,{value:7n})).wait();
 const protectedCollateral=await clearing.collateralOf(other.address),protectedMaker=await clearing.makerBacking();
 await assert.rejects(clearing.executeTrade(secondPayload.intent,secondPayload.approval,secondPayload.report,secondPayload.userSignature,sigC,maliciousB,{value:7n}),error=>String(error.data).startsWith('0x50cb02e4'),'canonical gross cap must reject a conflicting compromised-signer quorum');
 assert.equal((await clearing.positionOf(other.address,0)).size,0n);assert.equal(await clearing.collateralOf(other.address),protectedCollateral);assert.equal(await clearing.makerBacking(),protectedMaker);
 await ethers.provider.send('evm_revert',[byzantineFork]);
 await signerApps[0].close();const legacy=new DatabaseSync(join(directory,'signer-0.sqlite'));legacy.exec('UPDATE approvals SET payload=NULL');legacy.close();await makeSigner(0).ready();
 assert.equal((await signerApps[0].inject({method:'GET',url:'/health'})).json().ok,false,'unfinalized incomplete legacy payload must close signer readiness');
 const recoveredQuorum=await requestTrade(api,other,'buy','1000','506');assert.equal(recoveredQuorum.statusCode,200,recoveredQuorum.body);assert(rejected.some(row=>row.index===0&&row.error==='legacy approval recovery is incomplete'));
 assert.equal(read(join(directory,'signer-0.sqlite'),'SELECT * FROM approvals').length,1,'unknown legacy risk must not permit a new signature');

 await ethers.provider.send('evm_increaseTime',[60]);await ethers.provider.send('evm_mine',[]);
 const stillBlocked=await requestTrade(api,other,'sell','11000','504');assert.equal(stillBlocked.statusCode,409,stillBlocked.body,'latest time must not release unfinalized signatures');
 finalized=true;const released=await requestTrade(api,other,'sell','11000','505');assert.equal(released.statusCode,200,released.body);assert((await clearing.positionOf(other.address,0)).size<0n);
 assert.equal(read(apiPath,'SELECT * FROM gross_reservations').length,1,'expired row must be removed and new inclusion retained');
 console.log('Gross reservation E2E passed: lost quorum response, API/signer restart, orphaned fill, split API quorum intersection, compromised-signer canonical cap and finalized-only expiry');
}finally{for(const app of apiApps)await app.close();for(const app of signerApps)await app.close();rmSync(directory,{recursive:true,force:true});}
