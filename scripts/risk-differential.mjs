import assert from "node:assert/strict";
import fs from "node:fs";
import { network } from "hardhat";

const { ethers } = await network.create({ network:"hardhatOp", chainType:"op" });
const [deployer] = await ethers.getSigners();
const artifact = JSON.parse(fs.readFileSync("artifacts/RFQRiskMath.json", "utf8"));
const risk = await new ethers.ContractFactory(artifact.abi, artifact.bytecode, deployer).deploy();
await risk.waitForDeployment();

const RATE=10n**12n,BASE=10n**18n,YEAR=365n*86_400n;
const abs=value=>value<0n?-value:value;
const floorDiv=(numerator,denominator)=>{
  let quotient=numerator/denominator;
  if(numerator<0n&&numerator%denominator!==0n)quotient--;
  return quotient;
};
const potential=(btc,eth)=>floorDiv(10_000n*btc*btc+2n*6_573n*btc*eth+12_000n*eth*eth,2n*RATE*1_000_000n);
const impactCost=(btc,eth,market,delta)=>potential(btc+(market===0?delta:0n),eth+(market===1?delta:0n))-potential(btc,eth);
const tradeAssessment=(btc,eth,oldSize,market,baseDelta,executionPrice,bid,ask)=>{
  const absoluteBase=abs(baseDelta),notional=absoluteBase*executionPrice/BASE,mark=(bid+ask)/2n,requiredImpact=impactCost(btc,eth,market,baseDelta*mark/BASE);
  const deliveredImpact=baseDelta>0n?absoluteBase*executionPrice/BASE-absoluteBase*ask/BASE:absoluteBase*bid/BASE-absoluteBase*executionPrice/BASE,next=oldSize+baseDelta;
  const reduces=oldSize!==0n&&abs(next)<abs(oldSize)&&(next===0n||(next>0n)===(oldSize>0n));return [notional,requiredImpact,deliveredImpact,reduces];
};
const positionTransition=(oldSize,oldEntry,delta,price)=>{
  const nextSize=oldSize+delta;
  if(oldSize===0n||(oldSize>0n)===(delta>0n)){
    const combined=abs(nextSize),nextEntry=combined===0n?0n:(abs(oldSize)*oldEntry+abs(delta)*price)/combined;
    return [nextSize,nextEntry,0n];
  }
  const closed=abs(delta)<abs(oldSize)?abs(delta):abs(oldSize);
  const realized=oldSize>0n?closed*price/BASE-closed*oldEntry/BASE:closed*oldEntry/BASE-closed*price/BASE;
  const nextEntry=nextSize===0n?0n:(nextSize>0n)!==(oldSize>0n)?price:oldEntry;
  return [nextSize,nextEntry,realized];
};
const positionPnl=(size,entry,mark)=>size===0n?0n:size>0n?abs(size)*mark/BASE-abs(size)*entry/BASE:abs(size)*entry/BASE-abs(size)*mark/BASE;
const stressLoss=(btc,eth)=>[[20n,25n],[-20n,-25n],[15n,-20n],[-15n,20n],[40n,50n],[-40n,-50n]].reduce((best,[b,e])=>{const value=floorDiv(btc*b,100n)+floorDiv(eth*e,100n);return value>best?value:best;},0n);
const marginRate=(notional,initial)=>notional<=25_000n*1_000_000n?(initial?2_000n:1_200n):notional<=100_000n*1_000_000n?(initial?2_500n:1_500n):notional<=250_000n*1_000_000n?(initial?3_300n:2_000n):notional<=1_000_000n*1_000_000n?(initial?5_000n:3_000n):notional<=2_500_000n*1_000_000n?(initial?6_700n:4_000n):notional<=5_000_000n*1_000_000n?(initial?10_000n:6_000n):(1n<<256n)-1n;
const liquidationClose=(size,mark,equity)=>{
  const absoluteBase=abs(size),notional=absoluteBase*mark/BASE;
  if(notional<=10_000n*1_000_000n||equity<=0n)return absoluteBase;
  const shortfall=2_200n*notional>equity*10_000n?2_200n*notional-equity*10_000n:0n;
  const needed=(shortfall+2_149n)/2_150n,closeNotional=needed<notional/4n?needed:notional/4n;
  const closed=(closeNotional*BASE+mark-1n)/mark;
  return closed>absoluteBase?absoluteBase:closed;
};
const liquidationCharge=(closed,mark,available)=>{let penalty=closed*mark/BASE*50n/10_000n;if(penalty>available)penalty=available;let reward=closed*mark/BASE*10n/10_000n;if(reward>penalty/5n)reward=penalty/5n;return [penalty,reward];};
const fundingStep=(aggregate,mark,index,fundingTime,currentTime,maxNotional)=>{
  let elapsed=currentTime-fundingTime;if(elapsed===0n)return [index,fundingTime];
  const skew=aggregate*mark/BASE;let apr=skew*RATE/maxNotional;if(apr>RATE)apr=RATE;if(apr<-RATE)apr=-RATE;
  return [index+mark*apr*elapsed/(RATE*YEAR),fundingTime+elapsed];
};

let state=0x9e3779b9;
const random=()=>{state^=state<<13;state^=state>>>17;state^=state<<5;return state>>>0;};
const signed=max=>BigInt(random()%max)*(random()%2?1n:-1n);
const vectors=Number(process.env.RFQ_DIFFERENTIAL_VECTORS??1_500),chunkSize=50;
for(let start=0;start<vectors;start+=chunkSize){
  await Promise.all(Array.from({length:Math.min(chunkSize,vectors-start)},async()=>{
    const oldSize=signed(25_000)*10n**15n,delta=signed(30_000)*10n**15n,entry=BigInt(1+random()%150_000)*1_000_000n,price=BigInt(1+random()%150_000)*1_000_000n;
    assert.deepEqual([...(await risk.positionTransition(oldSize,entry,delta,price))],positionTransition(oldSize,entry,delta,price));
    assert.equal(await risk.positionPnl(oldSize,entry,price),positionPnl(oldSize,entry,price));
    const btc=signed(5_000_000)*1_000_000n,eth=signed(5_000_000)*1_000_000n,market=random()%2,usdDelta=signed(1_000_000)*1_000_000n;
    assert.equal(await risk.impactCost(btc,eth,market,usdDelta),impactCost(btc,eth,market,usdDelta));
    const spread=price/10_000n+1n,bid=price-spread,ask=price+spread,executionPrice=delta>0n?ask+BigInt(random()%100)*1_000_000n:bid-BigInt(random()%100)*1_000_000n;
    assert.deepEqual([...(await risk.tradeAssessment(btc,eth,oldSize,market,delta,executionPrice,bid,ask))],tradeAssessment(btc,eth,oldSize,market,delta,executionPrice,bid,ask));
    assert.equal(await risk.stressLoss(btc,eth),stressLoss(btc,eth));
    const notional=BigInt(random()%7_000_000)*1_000_000n,initial=random()%2===0;
    assert.equal(await risk.marginRate(notional,initial),marginRate(notional,initial));
    const equity=signed(1_000_000)*1_000_000n,closed=liquidationClose(oldSize,price,equity);
    assert.equal(await risk.liquidationClose(oldSize,price,equity),closed);
    const available=BigInt(random()%1_000_000)*1_000_000n;
    assert.deepEqual([...(await risk.liquidationCharge(closed,price,available))],liquidationCharge(closed,price,available));
    const fundingTime=1_000_000n,currentTime=fundingTime+BigInt(random()%(10*86_400)),maxNotional=BigInt(1+random()%5_000_000)*1_000_000n,index=signed(100_000)*1_000_000n;
    assert.deepEqual([...(await risk.fundingStep(oldSize,price,index,fundingTime,currentTime,maxNotional))],fundingStep(oldSize,price,index,fundingTime,currentTime,maxNotional));
  }));
}
console.log(`Risk differential passed: ${vectors} seeded vectors across 9 independently modeled functions (${vectors*9} comparisons)`);
