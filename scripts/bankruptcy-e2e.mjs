import assert from 'node:assert/strict';
import fs from 'node:fs';
import {network} from 'hardhat';
import {deployLinked,launchMarkets} from './lib/contract-fixture.mjs';
const {ethers}=await network.create({network:'hardhatOp',chainType:'op'});
const [governance,emergency,a,b,c,maker,user,keeper]=await ethers.getSigners(),libraries={};
const artifact=name=>JSON.parse(fs.readFileSync(`artifacts/${name}.json`,'utf8'));
const deploy=(name,args=[])=>deployLinked(governance,name,args,libraries);
const token=await deploy('MockUSDC'),oracle=await deploy('MockPriceOracle'),risk=await deploy('RFQRiskMath'),signatures=await deploy('RFQSignatureVerifier');libraries.RFQRiskMath=await risk.getAddress();libraries.RFQSignatureVerifier=await signatures.getAddress();
const implementation=await deploy('RFQClearing'),init=new ethers.Interface(artifact('RFQClearing').abi).encodeFunctionData('initialize',[await token.getAddress(),await oracle.getAddress(),governance.address,emergency.address,[a.address,b.address,c.address],600_000_000_000n,launchMarkets()]);
const proxy=await deploy('TestProxy',[await implementation.getAddress(),governance.address,init]),clearing=new ethers.Contract(await proxy.getAddress(),artifact('RFQClearing').abi,governance);await (await clearing.unpause()).wait();
await (await token.mint(maker.address,750_000_000_000n)).wait();await (await token.connect(maker).approve(await proxy.getAddress(),ethers.MaxUint256)).wait();await (await clearing.connect(maker).fundMaker(600_000_000_000n)).wait();await (await clearing.connect(maker).fundInsurance(150_000_000_000n)).wait();
await (await token.mint(user.address,4_000_000_000n)).wait();await (await token.connect(user).approve(await proxy.getAddress(),ethers.MaxUint256)).wait();await (await clearing.connect(user).deposit(4_000_000_000n)).wait();
const IMPACT_K=[10_000,12_000],prices=[100_000_000_000n,4_000_000_000n],report=async market=>{const block=await ethers.provider.getBlock('latest');return ethers.AbiCoder.defaultAbiCoder().encode(['tuple(uint8 market,uint256 bid,uint256 ask,uint64 observedAt,uint64 validUntil)[]'],[[[market,prices[market],prices[market],block.timestamp,block.timestamp+60]]]);};
for(let market=0;market<2;market++)await (await clearing.refreshOracle(await report(market))).wait();
const domain={name:'RFQ Markets',version:'1',chainId:(await ethers.provider.getNetwork()).chainId,verifyingContract:await proxy.getAddress()};
const types={TradeIntent:[{name:'account',type:'address'},{name:'market',type:'uint8'},{name:'baseDelta',type:'int256'},{name:'limitPrice',type:'uint256'},{name:'maxFee',type:'uint256'},{name:'nonce',type:'uint256'},{name:'deadline',type:'uint64'},{name:'reduceOnly',type:'bool'}]},approvalTypes={MakerApproval:[{name:'intentHash',type:'bytes32'},{name:'executionPrice',type:'uint256'},{name:'impactCharge',type:'int256'},{name:'fee',type:'uint256'},{name:'oracleReportHash',type:'bytes32'},{name:'deadline',type:'uint64'},{name:'leaderEpoch',type:'uint64'},{name:'signerSetVersion',type:'uint64'},{name:'policyVersion',type:'uint64'}]};
for(let market=0;market<2;market++){
 const baseDelta=market===0?100_000_000_000_000_000n:2_000_000_000_000_000_000n,proof=await report(market),btc=await clearing.markets(0),eth=await clearing.markets(1),impact=await risk.impactCost(IMPACT_K[market],[btc,eth][market].aggregateBase*prices[market]/10n**18n,baseDelta*prices[market]/10n**18n),charge=impact>0n?impact:0n,premium=(charge*10n**18n+baseDelta-1n)/baseDelta,executionPrice=prices[market]+premium;
 const block=await ethers.provider.getBlock('latest'),intent={account:user.address,market,baseDelta,limitPrice:executionPrice,maxFee:0n,nonce:BigInt(market+1),deadline:BigInt(block.timestamp+60),reduceOnly:false},approval={intentHash:ethers.TypedDataEncoder.hash(domain,types,intent),executionPrice,impactCharge:charge,fee:0n,oracleReportHash:ethers.keccak256(proof),deadline:intent.deadline,leaderEpoch:1n,signerSetVersion:1n,policyVersion:1n};
 await (await clearing.executeTrade(intent,approval,proof,await user.signTypedData(domain,types,intent),await a.signTypedData(domain,approvalTypes,approval),await b.signTypedData(domain,approvalTypes,approval))).wait();
}
const opened=await ethers.provider.send('evm_snapshot',[]);
const balances=async()=>({collateral:await clearing.collateralOf(user.address),maker:await clearing.makerBacking(),insurance:await clearing.insuranceBalance(),custody:await token.balanceOf(await proxy.getAddress()),btc:(await clearing.positionOf(user.address,0)).size,eth:(await clearing.positionOf(user.address,1)).size});
prices[0]=50_000_000_000n;prices[1]=2_000_000_000n;
for(let market=0;market<2;market++)await (await clearing.refreshOracle(await report(market))).wait();
assert((await clearing.maintenanceEquity(user.address))<0n);
// Tight limits produce material funding per second; both clocks must advance
// before netting, regardless of the keeper's selected market.
await (await clearing.setMarketPolicy(0,true,5_000_000_000n,5_000_000_000n)).wait();
await (await clearing.setMarketPolicy(1,true,5_000_000_000n,5_000_000_000n)).wait();
const before=await balances(),branch=await ethers.provider.send('evm_snapshot',[]);
await (await clearing.connect(keeper).liquidate(user.address,0,await report(0))).wait();const btcFirst=await balances();assert.equal(btcFirst.btc,0n);assert.equal(btcFirst.eth,0n);assert.equal(btcFirst.collateral,0n);assert.equal(btcFirst.custody,before.custody);
await ethers.provider.send('evm_revert',[branch]);await (await clearing.connect(keeper).liquidate(user.address,1,await report(1))).wait();assert.deepEqual(await balances(),btcFirst,'keeper market changed bankruptcy waterfall');
await ethers.provider.send('evm_revert',[opened]);const solvencySnapshot=await ethers.provider.send('evm_snapshot',[]);prices[0]=50_000_000_000n;prices[1]=5_000_000_000n;
for(let market=0;market<2;market++)await (await clearing.refreshOracle(await report(market))).wait();const insurance=await clearing.insuranceBalance();assert((await clearing.maintenanceEquity(user.address))>0n);assert((await clearing.maintenanceEquity(user.address))<(await clearing.maintenanceMargin(user.address)));
await (await clearing.connect(keeper).liquidate(user.address,0,await report(0))).wait();assert.equal((await clearing.positionOf(user.address,0)).size,0n);assert.equal((await clearing.positionOf(user.address,1)).size,0n);assert((await clearing.collateralOf(user.address))>0n);assert((await clearing.insuranceBalance())>=insurance,'unrealized winner was erased by default absorption');
console.log('Bankruptcy E2E passed: both legs closed, one waterfall, keeper market independence, winner offset realized before absorption');

await ethers.provider.send('evm_revert',[solvencySnapshot]);const ownerExitSnapshot=await ethers.provider.send('evm_snapshot',[]);
prices[0]=50_000_000_000n;prices[1]=2_000_000_000n;
await (await clearing.pause()).wait();const exitInsurance=await clearing.insuranceBalance();
await (await clearing.connect(user).closePosition(0,await report(0))).wait();
assert((await clearing.collateralOf(user.address))<0n,'fixture must leave debt after first close');
assert.equal(await clearing.insuranceBalance(),exitInsurance,'default must wait for the remaining position');
assert.notEqual((await clearing.positionOf(user.address,1)).size,0n);
const lastClose=await (await clearing.connect(user).closePosition(1,await report(1))).wait();
assert.equal(await clearing.collateralOf(user.address),0n,'flat owner account debt must converge');
assert((await clearing.insuranceBalance())<exitInsurance,'final losing close must absorb debt');
assert.equal(lastClose.logs.filter(log=>{try{return clearing.interface.parseLog(log)?.name==='DeficitAbsorbed';}catch{return false;}}).length,1);
assert.equal(await clearing.resolutionRequired(),false);
const settledInsurance=await clearing.insuranceBalance();
await assert.rejects(clearing.connect(user).closePosition(1,await report(1)));
assert.equal(await clearing.insuranceBalance(),settledInsurance,'repeated close must not absorb debt twice');
console.log('Owner exit default regression passed: remaining leg preserved, final debt absorbed once');

await ethers.provider.send('evm_revert',[ownerExitSnapshot]);const ownerWinnerSnapshot=await ethers.provider.send('evm_snapshot',[]);
prices[0]=50_000_000_000n;prices[1]=5_000_000_000n;
await (await clearing.pause()).wait();const offsetInsurance=await clearing.insuranceBalance();
await (await clearing.connect(user).closePosition(0,await report(0))).wait();
assert((await clearing.collateralOf(user.address))<0n);
assert.equal(await clearing.insuranceBalance(),offsetInsurance);
await (await clearing.connect(user).closePosition(1,await report(1))).wait();
assert((await clearing.collateralOf(user.address))>0n,'remaining owner winner must restore collateral');
assert.equal(await clearing.insuranceBalance(),offsetInsurance,'solvent owner must not consume insurance');
console.log('Owner winner regression passed: interim debt preserved until offset realizes');

await ethers.provider.send('evm_revert',[ownerWinnerSnapshot]);prices[0]=10_000_000_000_000n;prices[1]=4_000_000_000n;
for(let market=0;market<2;market++)await (await clearing.refreshOracle(await report(market))).wait();
await (await clearing.pause()).wait();const unpaidPosition=await clearing.positionOf(user.address,0),unpaidCollateral=await clearing.collateralOf(user.address);
await (await clearing.connect(user).closePosition(0,await report(0))).wait();assert.equal(await clearing.resolutionRequired(),true,'maker exhaustion must commit resolution');assert.equal((await clearing.positionOf(user.address,0)).size,unpaidPosition.size,'unpaid winner must remain in resolution');assert((await clearing.collateralOf(user.address))<=unpaidCollateral,'unfunded PnL must not be credited before resolution');
console.log('Maker exhaustion regression passed: resolution committed, unpaid position/collateral preserved');
