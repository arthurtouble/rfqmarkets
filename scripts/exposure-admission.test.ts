import assert from 'node:assert/strict';
import {test} from 'node:test';
import {exposureAdmission,isPositionReduction,makerStress,pendingMakerDebit,type ExposureMarket,type ExposureBook} from '../packages/shared/src/exposure-admission.js';
const BASE=10n**18n,word=(gross:bigint,side=gross)=>gross|(side<<128n),max=5_000_000_000_000n;
function fixture(){const btc:ExposureMarket={aggregateBase:0n,fundingIndex:0n,fundingTime:100n,lastPriceTime:100n,lastBid:100_000_000_000n,lastAsk:100_000_000_000n,enabled:true},eth={...btc,lastBid:4_000_000_000n,lastAsk:4_000_000_000n};const books:[ExposureBook,ExposureBook]=[{longBase:BASE/10n,shortBase:BASE/10n,limits:word(25_000_000_000n,20_000_000_000n),ready:true},{longBase:0n,shortBase:0n,limits:word(max),ready:true}];return {markets:[btc,eth] as [ExposureMarket,ExposureMarket],books,netLimits:[word(max),word(max)] as [bigint,bigint],market:0 as 0|1,position:{size:0n,entryPrice:0n,lastFundingIndex:0n},delta:BASE/10n,executionPrice:100_000_000_000n,timestamp:100n,backing:100_000_000_000n,floor:100_000_000_000n};}
test('independent exposure model rejects netting bypasses, stale gross and incomplete migration',()=>{
 let input=fixture();assert.equal(exposureAdmission(input).reason,'gross_or_side_cap');
 input=fixture();input.books[0].limits=word(50_000_000_000n,15_000_000_000n);input.delta=6n*BASE/100n;assert.equal(exposureAdmission(input).reason,'gross_or_side_cap');
 input=fixture();input.market=1;input.delta=BASE;input.timestamp=116n;assert.equal(exposureAdmission(input).reason,'stale_gross_price');
 input=fixture();input.books[0].ready=false;assert.equal(exposureAdmission(input).reason,'exposure_migration_required');
});
test('tightened caps permit improvements and disabled markets permit safe owner reductions',()=>{
 const input=fixture();input.position={size:BASE/10n,entryPrice:100_000_000_000n,lastFundingIndex:0n};input.delta=-BASE/20n;input.books[0].limits=word(10_000_000_000n,5_000_000_000n);input.markets[0].enabled=false;
 assert.equal(exposureAdmission(input).allowed,true);
 input.netLimits[0]=word(1_000_000_000n);assert.equal(exposureAdmission(input).reason,'net_cap','removing an offset must not increase an over-limit net exposure');
 input.markets[0].aggregateBase=BASE/10n;input.books[0].shortBase=0n;assert.equal(exposureAdmission(input).allowed,true);
 assert.equal(isPositionReduction(BASE/10n,-BASE/5n),false,'crossing through zero is an opening');
});
test('capital floor includes funding and realized PnL rather than fee-funded prospective capital',()=>{
 const input=fixture();input.books[0].limits=word(max);input.backing-=1n;assert.equal(exposureAdmission(input).reason,'maker_capital_or_disabled');
 input.backing=input.floor;input.position={size:BASE/10n,entryPrice:90_000_000_000n,lastFundingIndex:0n};input.delta=-BASE/5n;assert.equal(exposureAdmission(input).reason,'maker_capital_or_disabled','crossing trade must include realized winner debit');
 input.delta=-BASE/10n;assert.equal(exposureAdmission(input).allowed,true,'closing a funded winner may cross the opening capital floor');
});
test('stress scenarios preserve separate-leg floor rounding for negative quantities',()=>{
 assert.equal(makerStress(1n,-1n),0n);assert.equal(makerStress(101n,-1n),39n);assert.equal(makerStress(-101n,1n),39n);
});
test('pending maker debit bounds realized PnL and funding across seeded positions',()=>{
 let seed=0x51f15e;const rand=()=>{seed^=seed<<13;seed^=seed>>>17;seed^=seed<<5;return seed>>>0;},abs=(value:bigint)=>value<0n?-value:value,YEAR=365n*86400n,RATE=10n**12n;
 for(let i=0;i<10_000;i++){
  const timestamp=1_000n+BigInt(rand()%10_000),price=(1_000n+BigInt(rand()%100_000))*1_000_000n,entry=(1n+BigInt(rand()%200_000))*1_000_000n,size=BigInt(rand()%1_000_000)*10n**12n*(rand()%2?1n:-1n),delta=BigInt(rand()%1_000_000+1)*10n**12n*(rand()%2?1n:-1n),aggregate=BigInt(rand()%2_000_000)*10n**12n*(rand()%2?1n:-1n),cap=5_000_000_000_000n,fundingTime=timestamp-BigInt(rand()%1000),lastIndex=BigInt(rand()%1_000_000)*(rand()%2?1n:-1n),market:ExposureMarket={aggregateBase:aggregate,fundingIndex:lastIndex,fundingTime,lastPriceTime:timestamp,lastBid:price,lastAsk:price,enabled:true},position={size,entryPrice:entry,lastFundingIndex:lastIndex-BigInt(rand()%1_000_000)*(rand()%2?1n:-1n)},deadline=timestamp+BigInt(rand()%31);
  let apr=aggregate*price/BASE*RATE/cap;apr=apr>RATE?RATE:apr< -RATE?-RATE:apr;const change=price*abs(apr)*(timestamp-fundingTime)/(RATE*YEAR),index=lastIndex+(apr<0n?-change:change),payment=size*(index-position.lastFundingIndex)/BASE,closed=size!==0n&&(size>0n)!==(delta>0n)?(abs(delta)<abs(size)?abs(delta):abs(size)):0n,pnl=size>0n?closed*price/BASE-closed*entry/BASE:closed*entry/BASE-closed*price/BASE,actual=(payment<0n?-payment:0n)+(pnl>0n?pnl:0n),reserved=pendingMakerDebit({position,market,delta,executionPrice:price,timestamp,deadline,netLimit:cap<<128n});assert(reserved>=actual,`capital envelope ${i}`);
 }
});
