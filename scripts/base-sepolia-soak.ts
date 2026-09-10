import { spawn } from "node:child_process";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const cycles=Number(process.env.RFQ_TESTNET_SOAK_CYCLES??3),intervalMs=Number(process.env.RFQ_TESTNET_SOAK_INTERVAL_MS??30_000);
if(!Number.isInteger(cycles)||cycles<1||cycles>1_000)throw new Error("RFQ_TESTNET_SOAK_CYCLES must be an integer from 1 to 1000");
if(!Number.isInteger(intervalMs)||intervalMs<0||intervalMs>3_600_000)throw new Error("RFQ_TESTNET_SOAK_INTERVAL_MS must be between 0 and 3600000");
const sleep=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
async function run(script:string){
  const started=Date.now();
  await new Promise<void>((resolveRun,reject)=>{const child=spawn("npm",["run",script],{cwd:resolve("."),env:process.env,stdio:"inherit"});child.once("error",reject);child.once("exit",(code,signal)=>code===0?resolveRun():reject(new Error(`${script} exited ${code??signal}`)));});
  return Date.now()-started;
}
const report={startedAt:new Date().toISOString(),cycles,intervalMs,completed:0,results:[] as Array<{cycle:number;btcLifecycleMs:number;hedgedLifecycleMs:number}>};
try{
  for(let cycle=1;cycle<=cycles;cycle++){
    const btcLifecycleMs=await run("smoke:base-sepolia-iteration-e2e"),hedgedLifecycleMs=await run("smoke:base-sepolia-iteration-hedge-e2e");
    report.results.push({cycle,btcLifecycleMs,hedgedLifecycleMs});report.completed=cycle;
    if(cycle<cycles)await sleep(intervalMs);
  }
}finally{
  mkdirSync(resolve(".local-state"),{recursive:true});const destination=resolve(".local-state/testnet-soak-latest.json"),temporary=`${destination}.tmp`;
  writeFileSync(temporary,JSON.stringify({...report,finishedAt:new Date().toISOString()},null,2));renameSync(temporary,destination);
}
console.log(JSON.stringify({passed:true,...report},null,2));
