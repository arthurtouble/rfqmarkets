import assert from "node:assert/strict";
import fs from "node:fs";
import { network } from "hardhat";
import { MAX_MARKET_CONFIG, deployLinked } from "./lib/contract-fixture.mjs";

const { ethers } = await network.create({ network:"hardhatOp", chainType:"op" });
const [governance, emergency, approverA, approverB, approverC, maker, relayer, ...users] = await ethers.getSigners();
const traders=users.slice(0,4),artifact=name=>JSON.parse(fs.readFileSync(`artifacts/${name}.json`,"utf8"));
const libraries={};
const deploy=(name,args=[])=>deployLinked(governance,name,args,libraries);
const token=await deploy("MockUSDC"),oracle=await deploy("MockPriceOracle"),risk=await deploy("RFQRiskMath");libraries.RFQRiskMath=await risk.getAddress();const signatureVerifier=await deploy("RFQSignatureVerifier");libraries.RFQSignatureVerifier=await signatureVerifier.getAddress();
const implementation=await deploy("RFQClearing");
const init=new ethers.Interface(artifact("RFQClearing").abi).encodeFunctionData("initialize",[
  await token.getAddress(),await oracle.getAddress(),governance.address,emergency.address,
  [approverA.address,approverB.address,approverC.address],600_000_000_000n,[MAX_MARKET_CONFIG,MAX_MARKET_CONFIG],
]);
const proxy=await deploy("TestProxy",[await implementation.getAddress(),governance.address,init]);
const clearing=new ethers.Contract(await proxy.getAddress(),artifact("RFQClearing").abi,governance);await (await clearing.unpause()).wait();
await (await token.mint(maker.address,900_000_000_000n)).wait();await (await token.connect(maker).approve(await clearing.getAddress(),ethers.MaxUint256)).wait();
await (await clearing.connect(maker).fundMaker(750_000_000_000n)).wait();await (await clearing.connect(maker).fundInsurance(150_000_000_000n)).wait();
for(const trader of traders){await (await token.mint(trader.address,100_000_000_000n)).wait();await (await token.connect(trader).approve(await clearing.getAddress(),ethers.MaxUint256)).wait();await (await clearing.connect(trader).deposit(100_000_000_000n)).wait();}

const coder=ethers.AbiCoder.defaultAbiCoder(),observationType="tuple(uint8 market,uint256 bid,uint256 ask,uint64 observedAt,uint64 validUntil)";
const prices=[{bid:99_990_000_000n,ask:100_010_000_000n},{bid:3_999_000_000n,ask:4_001_000_000n}];
const report=async market=>{const block=await ethers.provider.getBlock("latest"),price=prices[market];return coder.encode([observationType],[[market,price.bid,price.ask,BigInt(block.timestamp),BigInt(block.timestamp+60)]]);};
for(let market=0;market<2;market++)await (await clearing.refreshOracle(await report(market))).wait();
const chain=await ethers.provider.getNetwork(),domain={name:"RFQ Markets",version:"1",chainId:chain.chainId,verifyingContract:await clearing.getAddress()};
const intentTypes={TradeIntent:[
  {name:"account",type:"address"},{name:"market",type:"uint8"},{name:"baseDelta",type:"int256"},{name:"limitPrice",type:"uint256"},{name:"maxFee",type:"uint256"},{name:"nonce",type:"uint256"},{name:"deadline",type:"uint64"},{name:"reduceOnly",type:"bool"},
]};
const approvalTypes={MakerApproval:[
  {name:"intentHash",type:"bytes32"},{name:"executionPrice",type:"uint256"},{name:"impactCharge",type:"int256"},{name:"fee",type:"uint256"},{name:"oracleReportHash",type:"bytes32"},{name:"deadline",type:"uint64"},{name:"leaderEpoch",type:"uint64"},{name:"signerSetVersion",type:"uint64"},{name:"policyVersion",type:"uint64"},
]};
const abs=value=>value<0n?-value:value,ceilDiv=(value,divisor)=>value/divisor+(value%divisor===0n?0n:1n);
let seed=Number(process.env.RFQ_STATEFUL_SEED??0x243f6a88),executed=0;
const random=()=>{seed^=seed<<13;seed^=seed>>>17;seed^=seed<<5;return seed>>>0;};
const steps=Number(process.env.RFQ_STATEFUL_STEPS??600);

async function assertAccounting(){
  let collateral=0n;const sums=[0n,0n],longs=[0n,0n],shorts=[0n,0n];
  for(const trader of traders){collateral+=await clearing.collateralOf(trader.address);for(let market=0;market<2;market++){const size=(await clearing.positionOf(trader.address,market)).size;sums[market]+=size;if(size>0n)longs[market]+=size;else shorts[market]-=size;}}
  assert.equal(collateral,await clearing.totalCustomerCollateral(),"customer collateral aggregate drifted");
  for(let market=0;market<2;market++)assert.equal(sums[market],(await clearing.markets(market)).aggregateBase,`market ${market} aggregate drifted`);
  for(let market=0;market<2;market++){const book=await clearing.exposureState(market);assert.equal(book.longBase,longs[market]);assert.equal(book.shortBase,shorts[market]);}
  assert.equal(await token.balanceOf(await clearing.getAddress()),BigInt(await clearing.makerBacking())+BigInt(await clearing.insuranceBalance())+collateral,"internal accounting no longer matches token custody");
}

for(let step=0;step<steps;step++){
  // Walk both markets through deterministic calm and volatile regimes. The wide
  // collateral cushion keeps this a state-transition test rather than a solvency test.
  for(let index=0;index<2;index++){
    const mid=(prices[index].bid+prices[index].ask)/2n,shockBps=BigInt((random()%401)-200),nextMid=mid*(10_000n+shockBps)/10_000n;
    prices[index]={bid:nextMid*9_999n/10_000n,ask:nextMid*10_001n/10_000n};
  }
  const trader=traders[random()%traders.length],market=random()%2,price=prices[market],mid=(price.bid+price.ask)/2n;
  const unit=market===0?1_000_000_000_000_000n:25_000_000_000_000_000n;
  let delta=unit*BigInt(1+random()%5)*(random()%2===0?1n:-1n);
  const current=(await clearing.positionOf(trader.address,market)).size;
  const max=unit*25n;if(abs(current+delta)>max)delta=current>0n?-unit:unit;
  const other=market===0?1:0;await (await clearing.refreshOracle(await report(other))).wait();const tradeReport=await report(market);
  const btc=await clearing.markets(0),eth=await clearing.markets(1);
  // executeTrade records the target market's new observation before evaluating
  // cross-market impact, so the reference state must use that same observation.
  const btcUsd=btc.aggregateBase*(prices[0].bid+prices[0].ask)/2n/10n**18n,ethUsd=eth.aggregateBase*(prices[1].bid+prices[1].ask)/2n/10n**18n,deltaUsd=delta*mid/10n**18n;
  const rawImpact=await risk.impactCost(btcUsd,ethUsd,market,deltaUsd),impact=rawImpact>0n?rawImpact:0n;
  // One price quantum can be smaller than one USDC micro-unit of delivered
  // impact. Round the premium until the contract's two-floor calculation meets
  // the required charge exactly; this mirrors the production quoter's guarantee.
  let premium=ceilDiv(impact*10n**18n,abs(delta)),executionPrice=delta>0n?price.ask+premium:price.bid-premium;
  const delivered=()=>delta>0n?abs(delta)*executionPrice/10n**18n-abs(delta)*price.ask/10n**18n:abs(delta)*price.bid/10n**18n-abs(delta)*executionPrice/10n**18n;
  while(delivered()<impact){premium+=ceilDiv(10n**18n,abs(delta));executionPrice=delta>0n?price.ask+premium:price.bid-premium;}
  const notional=abs(delta)*executionPrice/10n**18n,fee=ceilDiv(notional*2n,10_000n),block=await ethers.provider.getBlock("latest"),nonce=BigInt(step+1),deadline=BigInt(block.timestamp+60);
  const intent={account:trader.address,market,baseDelta:delta,limitPrice:delta>0n?executionPrice+executionPrice/1_000n:executionPrice-executionPrice/1_000n,maxFee:fee,nonce,deadline,reduceOnly:false};
  const userSignature=await trader.signTypedData(domain,intentTypes,intent),intentHash=ethers.TypedDataEncoder.hash(domain,intentTypes,intent);
  const approval={intentHash,executionPrice,impactCharge:impact,fee,oracleReportHash:ethers.keccak256(tradeReport),deadline,leaderEpoch:1n,signerSetVersion:1n,policyVersion:1n};
  const sigA=await approverA.signTypedData(domain,approvalTypes,approval),sigB=await approverB.signTypedData(domain,approvalTypes,approval);
  try{await (await clearing.connect(relayer).executeTrade(intent,approval,tradeReport,userSignature,sigA,sigB)).wait();}
  catch(error){console.error({step,market,delta,current,btcUsd,ethUsd,deltaUsd,impact,delivered:delivered(),executionPrice,limitPrice:intent.limitPrice,notional});throw error;}executed++;
  assert.equal(await clearing.nonceUsed(trader.address,nonce),true,"successful trade did not consume nonce");
  if(step%17===0){let replayed=false;try{await (await clearing.connect(relayer).executeTrade(intent,approval,tradeReport,userSignature,sigA,sigB)).wait();replayed=true;}catch{}assert.equal(replayed,false,"trade replay succeeded");}
  await assertAccounting();
}

assert.equal(executed,steps);console.log(`Stateful clearing E2E passed: ${steps} deterministic multi-account/cross-market trades through price shocks with replay, exposure and custody invariants`);

// Resolution includes already accrued but unsettled funding and must be
// independent of keeper batching or wall-clock delay after the trigger.
await (await clearing.pause()).wait();
await ethers.provider.send('evm_increaseTime',[3600]);await ethers.provider.send('evm_mine',[]);
for(let market=0;market<2;market++)await (await clearing.refreshOracle(await report(market))).wait();
let frozenMarkets=await Promise.all([clearing.markets(0),clearing.markets(1)]),frozenAccounts=await Promise.all(traders.map(async trader=>({address:trader.address,collateral:await clearing.collateralOf(trader.address),positions:await Promise.all([clearing.positionOf(trader.address,0),clearing.positionOf(trader.address,1)])})));
assert(frozenAccounts.some(account=>account.positions.some((p,i)=>p.size!==0n&&p.lastFundingIndex!==frozenMarkets[i].fundingIndex)),'fixture needs unsettled funding');
await (await clearing.declareResolution()).wait();frozenMarkets=await Promise.all([clearing.markets(0),clearing.markets(1)]);
for(let sample=0;sample<3;sample++){for(let market=0;market<2;market++)await (await clearing.submitResolutionObservation(await report(market))).wait();if(sample<2){await ethers.provider.send('evm_increaseTime',[15]);await ethers.provider.send('evm_mine',[]);}}
const expected=await Promise.all(frozenAccounts.map(async account=>{let equity=account.collateral;for(let i=0;i<2;i++){const p=account.positions[i],mark=await clearing.resolutionPrice(i);equity+=await risk.positionPnl(p.size,p.entryPrice,mark);equity-=p.size*(frozenMarkets[i].fundingIndex-p.lastFundingIndex)/10n**18n;}return equity>0n?equity:0n;}));
const snapshot=await ethers.provider.send('evm_snapshot',[]);
await (await clearing.processResolution(100)).wait();for(let i=0;i<traders.length;i++)assert.equal(await clearing.resolutionClaim(traders[i].address),expected[i]);
await ethers.provider.send('evm_revert',[snapshot]);
await ethers.provider.send('evm_increaseTime',[3600]);await ethers.provider.send('evm_mine',[]);
await assert.rejects(clearing.refreshOracle(await report(0)));
for(let i=0;i<traders.length;i++)await (await clearing.processResolution(1)).wait();
for(let i=0;i<traders.length;i++)assert.equal(await clearing.resolutionClaim(traders[i].address),expected[i],'keeper batching/time changed resolution claim');
for(let market=0;market<2;market++){const book=await clearing.exposureState(market);assert.equal(book.longBase,0n);assert.equal(book.shortBase,0n);}
console.log('Resolution regression passed: unsettled funding, frozen indices, delayed one-account batching');
