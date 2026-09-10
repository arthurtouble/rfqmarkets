import { spawn } from "node:child_process";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const hours=Number(process.env.RFQ_TESTNET_SOAK_HOURS??0),requestedCycles=Number(process.env.RFQ_TESTNET_SOAK_CYCLES??3),intervalMs=Number(process.env.RFQ_TESTNET_SOAK_INTERVAL_MS??30_000),deadlineMs=hours>0?Date.now()+hours*3_600_000:0,cycles=hours>0?20_000:requestedCycles;
if(!Number.isInteger(cycles)||cycles<1||cycles>20_000)throw new Error("RFQ_TESTNET_SOAK_CYCLES must be an integer from 1 to 20000");
if(!Number.isFinite(hours)||hours<0||hours>168)throw new Error("RFQ_TESTNET_SOAK_HOURS must be between 0 and 168");
if(!Number.isInteger(intervalMs)||intervalMs<0||intervalMs>3_600_000)throw new Error("RFQ_TESTNET_SOAK_INTERVAL_MS must be between 0 and 3600000");
const sleep=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
async function run(script:string){
  const started=Date.now();
  await new Promise<void>((resolveRun,reject)=>{const child=spawn("npm",["run",script],{cwd:resolve("."),env:process.env,stdio:"inherit"});child.once("error",reject);child.once("exit",(code,signal)=>code===0?resolveRun():reject(new Error(`${script} exited ${code??signal}`)));});
  return Date.now()-started;
}
const destination=resolve(".local-state/testnet-soak-latest.json");
const report={startedAt:new Date().toISOString(),requestedHours:hours,cycles:hours>0?null:cycles,intervalMs,completed:0,failures:0,results:[] as Array<{cycle:number;btcLifecycleMs?:number;hedgedLifecycleMs?:number;error?:string}>};
function checkpoint(){mkdirSync(resolve(".local-state"),{recursive:true});const temporary=`${destination}.tmp`;writeFileSync(temporary,JSON.stringify({...report,checkpointAt:new Date().toISOString()},null,2));renameSync(temporary,destination);}
try{
  for(let cycle=1;cycle<=cycles;cycle++){
    try{const btcLifecycleMs=await run("smoke:base-sepolia-iteration-e2e"),hedgedLifecycleMs=await run("smoke:base-sepolia-iteration-hedge-e2e");report.results.push({cycle,btcLifecycleMs,hedgedLifecycleMs});}
    catch(error){report.failures++;report.results.push({cycle,error:String(error)});}
    report.completed=cycle;checkpoint();
    if((deadlineMs&&Date.now()>=deadlineMs)||cycle===cycles)break;
    await sleep(intervalMs);
  }
}finally{
  checkpoint();
}
console.log(JSON.stringify({passed:report.failures===0,...report},null,2));
if(report.failures)process.exitCode=1;
