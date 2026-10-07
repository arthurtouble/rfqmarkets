import assert from 'node:assert/strict';
import test from 'node:test';
import {identifyCandidate} from './candidate-identity.js';
import {createMainnetDeploymentPlan,validateDevManifest,validateMainnetManifest} from './mainnet-manifest.js';
const address=(byte:string)=>`0x${byte.repeat(40)}`,market={enabled:true,maxTradeUsdc:'10000000000',grossUsdc:'100000000000',sideUsdc:'75000000000',netUsdc:'75000000000',hedgeBandUsdc:'5000000000'};
const signers=[address('1'),address('2'),address('3')];
const valid=()=>({version:1,mode:'capped-canary',chainId:'8453',candidateHash:identifyCandidate().candidateHash,usdc:'0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',oracleSigners:[...signers],oracleThreshold:2,governance:address('4'),governanceSafe:address('a'),emergencyCouncil:address('5'),approvers:[address('6'),address('7'),address('8')],policy:{makerCapitalUsdc:'1000000000000',insuranceCapitalUsdc:'250000000000',dailyLossLimitUsdc:'25000000000',timelockSeconds:259200,markets:{BTC:market,ETH:market}}});
test('mainnet plan is candidate-bound, unsigned and conservatively capped',()=>{const plan=createMainnetDeploymentPlan(valid());assert.equal(plan.chainId,'8453');assert.equal(plan.executionAuthorized,false);assert.equal(plan.policy.markets.BTC.maxTradeUsdc,'10000000000');assert.ok(plan.deploymentOrder.some(step=>step.startsWith('SignedPriceOracle')));assert.ok(!plan.deploymentOrder.some(step=>/Pyth/.test(step)));assert.deepEqual(plan.initialization.oracleSigners,signers);assert.equal(plan.initialization.oracleThreshold,2);});
test('mainnet manifest fills oracle consensus and launch risk defaults',()=>{
 const value=validateMainnetManifest(valid());
 assert.deepEqual(value.oracle,{maxDeviationBps:50,maxSkew:5,maxJumpBps:0,jumpWindow:0});
 assert.deepEqual([value.policy.markets.BTC.impactK,value.policy.markets.BTC.shockBps,value.policy.markets.BTC.marginScaleBps],[10000,4000,10000]);
 assert.deepEqual([value.policy.markets.ETH.impactK,value.policy.markets.ETH.shockBps,value.policy.markets.ETH.marginScaleBps],[12000,5000,10000]);
 const custom:any=valid();custom.oracle={maxDeviationBps:100,maxSkew:3,maxJumpBps:500,jumpWindow:60};custom.policy.markets.ETH={...market,impactK:15000,shockBps:6000,marginScaleBps:12000};
 const parsed=validateMainnetManifest(custom);assert.equal(parsed.oracle.maxJumpBps,500);assert.equal(parsed.policy.markets.ETH.impactK,15000);assert.equal(parsed.policy.markets.BTC.impactK,10000);
});
test('mainnet manifest rejects role reuse, wrong USDC, weak insurance and loose caps',()=>{assert.throws(()=>validateMainnetManifest({...valid(),oracleSigners:[valid().governance,address('2'),address('3')]}),/distinct/);assert.throws(()=>validateMainnetManifest({...valid(),usdc:address('9')}),/USDC/);const weak=valid();weak.policy.insuranceCapitalUsdc='1';assert.throws(()=>validateMainnetManifest(weak),/Insurance/);const loose=valid();loose.policy.markets.BTC={...market,maxTradeUsdc:'20000000000'};assert.throws(()=>validateMainnetManifest(loose),/conservative/);});
test('mainnet manifest rejects a weak or malformed oracle configuration',()=>{
 assert.throws(()=>validateMainnetManifest({...valid(),oracleSigners:[address('1'),address('2')]}),/at least 3/);
 assert.throws(()=>validateMainnetManifest({...valid(),oracleSigners:Array.from({length:17},(_,index)=>`0x${(index+0x100).toString(16).padStart(40,'0')}`),oracleThreshold:9}),/at most 16/);
 assert.throws(()=>validateMainnetManifest({...valid(),oracleSigners:[address('1'),address('1'),address('3')]}),/distinct/);
 for(const threshold of [1,4])assert.throws(()=>validateMainnetManifest({...valid(),oracleThreshold:threshold}),/majority/);
 assert.throws(()=>validateMainnetManifest({...valid(),oracleSigners:[...signers,address('9')],oracleThreshold:2}),/majority/,'2 of 4 is not a majority');
 for(const oracle of [{maxDeviationBps:0},{maxDeviationBps:1001},{maxSkew:16},{jumpWindow:86401}])assert.throws(()=>validateMainnetManifest({...valid(),oracle}));
 assert.throws(()=>validateMainnetManifest({...valid(),oracle:{maxJumpBps:500}}),/jump guard/);
 assert.throws(()=>validateMainnetManifest({...valid(),oracleSource:address('9')}),/Unrecognized/,'the Pyth fields are gone');
 for(const risk of [{marginScaleBps:9000},{shockBps:100},{impactK:0}]){const risky:any=valid();risky.policy.markets.BTC={...market,...risk};assert.throws(()=>validateMainnetManifest(risky));}
});
test('mainnet manifest rejects caps the clearing contract would refuse',()=>{const wide=valid();wide.policy.markets.ETH={...market,maxTradeUsdc:'80000000000',grossUsdc:'800000000000'};assert.throws(()=>validateMainnetManifest(wide),/contract bounds/);const governanceReuse=valid();governanceReuse.governanceSafe=governanceReuse.emergencyCouncil;assert.throws(()=>validateMainnetManifest(governanceReuse),/distinct/);});
test('dev manifest maps owner to governance and enforces dev ceilings',()=>{
 const market={maxTradeUsdc:'25000000',netUsdc:'100000000',grossUsdc:'200000000',sideUsdc:'150000000'};
 const dev={version:1,mode:'dev',chainId:'8453',usdc:'0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',oracleSigners:[...signers],oracleThreshold:2,owner:address('4'),emergencyCouncil:address('5'),approvers:[address('6'),address('7'),address('8')],policy:{makerCapitalUsdc:'100000000',markets:{BTC:market,ETH:market}}};
 const value=validateDevManifest(dev);assert.equal(value.governance,value.owner);assert.equal(value.oracle.maxDeviationBps,50);assert.equal(value.policy.markets.ETH.impactK,12000);
 assert.throws(()=>validateDevManifest({...dev,policy:{...dev.policy,makerCapitalUsdc:'60000000000'}}),/dev ceiling/);
 assert.throws(()=>validateDevManifest({...dev,policy:{...dev.policy,markets:{BTC:{...market,maxTradeUsdc:'2000000000'},ETH:market}}}),/dev ceiling/);
 assert.throws(()=>validateDevManifest({...dev,emergencyCouncil:dev.owner}),/distinct/);
 assert.throws(()=>validateDevManifest({...dev,oracleSigners:[dev.owner,address('2'),address('3')]}),/distinct/);
 assert.throws(()=>validateDevManifest({...dev,oracleThreshold:1}),/majority/);
});
