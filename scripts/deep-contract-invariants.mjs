import assert from "node:assert/strict";
import {mkdirSync,writeFileSync} from "node:fs";
import {spawnSync} from "node:child_process";

const integer=(name,fallback)=>{const value=Number(process.env[name]??fallback);assert(Number.isSafeInteger(value)&&value>0,`${name} must be a positive safe integer`);return value;};
const seeds=(process.env.RFQ_DEEP_STATEFUL_SEEDS??"608135816,2654435769,3084996962,3735928559").split(",").map((value,index)=>{const parsed=Number(value);assert(Number.isInteger(parsed)&&parsed>=0&&parsed<=0xffffffff,`invalid stateful seed at index ${index}`);return parsed;});
assert.equal(new Set(seeds).size,seeds.length,"stateful seeds must be distinct");
const steps=integer("RFQ_DEEP_STATEFUL_STEPS",1_200),differentialVectors=integer("RFQ_DEEP_DIFFERENTIAL_VECTORS",50_000),differentialSeed=integer("RFQ_DEEP_DIFFERENTIAL_SEED",0x85ebca6b),cli="node_modules/hardhat/dist/src/cli.js",startedAt=new Date().toISOString();

function hardhat(script,environment){
  const result=spawnSync(process.execPath,[cli,"run","--no-compile","--network","hardhatOp",script],{stdio:"inherit",env:{...process.env,...environment}});
  if(result.error)throw result.error;
  if(result.status!==0)throw new Error(`${script} failed with status ${result.status}`);
}

hardhat("scripts/risk-differential.mjs",{RFQ_DIFFERENTIAL_VECTORS:String(differentialVectors),RFQ_DIFFERENTIAL_SEED:String(differentialSeed)});
for(const seed of seeds)hardhat("scripts/stateful-clearing-e2e.mjs",{RFQ_STATEFUL_STEPS:String(steps),RFQ_STATEFUL_SEED:String(seed)});
const evidence={version:1,startedAt,completedAt:new Date().toISOString(),differential:{seed:differentialSeed,vectors:differentialVectors,comparisons:differentialVectors*9},stateful:{seeds,stepsPerSeed:steps,totalTransitions:steps*seeds.length}};
mkdirSync(".local-state",{recursive:true,mode:0o700});writeFileSync(".local-state/deep-contract-invariants.json",`${JSON.stringify(evidence,null,2)}\n`,{mode:0o600});
console.log(JSON.stringify(evidence));
