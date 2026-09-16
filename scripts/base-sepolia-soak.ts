import {supervise} from './supervise.js';
import {mkdirSync,renameSync,writeFileSync,readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {identifyCandidate} from './candidate-identity.js';
import {resolve} from 'node:path';
const hours=Number(process.env.RFQ_TESTNET_SOAK_HOURS??0),cycles=Number(process.env.RFQ_TESTNET_SOAK_CYCLES??3),intervalMs=Number(process.env.RFQ_TESTNET_SOAK_INTERVAL_MS??30_000),childTimeoutMs=Number(process.env.RFQ_TESTNET_SOAK_CHILD_TIMEOUT_MS??900_000);
if(!Number.isFinite(hours)||hours<0||hours>168||!Number.isInteger(cycles)||cycles<1||cycles>20_000||!Number.isInteger(intervalMs)||intervalMs<0||intervalMs>3_600_000||!Number.isInteger(childTimeoutMs)||childTimeoutMs<1000||childTimeoutMs>3_600_000)throw new Error('Invalid soak duration, cycles, interval or child timeout');
const identity=identifyCandidate(),deploymentPath=resolve(process.env.RFQ_BASE_SEPOLIA_DEPLOYMENT_FILE??'.local-state/base-sepolia-iteration.json'),deploymentHash=createHash('sha256').update(readFileSync(deploymentPath)).digest('hex');
const started=Date.now(),monotonicStart=performance.now(),deadline=hours>0?monotonicStart+hours*3_600_000:0,runId=crypto.randomUUID(),destination=resolve(`.local-state/testnet-soak-${runId}.json`),latest=resolve('.local-state/testnet-soak-latest.json');
let interrupted=false,wake:(()=>void)|undefined;const abort=new AbortController();
for(const signal of ['SIGINT','SIGTERM'] as const)process.once(signal,()=>{interrupted=true;abort.abort();wake?.();});
const report={version:3,candidateHash:identity.candidateHash,finalCandidateHash:null as string|null,deploymentHash,finalDeploymentHash:null as string|null,runId,startedAt:new Date(started).toISOString(),requestedHours:hours,requestedCycles:hours?null:cycles,intervalMs,childTimeoutMs,completed:0,failures:0,status:'running',results:[] as Array<{cycle:number;script:string;durationMs:number;evidence?:Record<string,unknown>;error?:string}>};
function checkpoint(){mkdirSync(resolve('.local-state'),{recursive:true});const output=JSON.stringify({...report,elapsedMs:Math.round(performance.now()-monotonicStart),checkpointAt:new Date().toISOString()},null,2);for(const path of [destination,latest]){writeFileSync(`${path}.tmp`,output,{mode:0o600});renameSync(`${path}.tmp`,path);}}
function verifiedEvidence(output:string){
 for(let start=output.indexOf('{');start>=0;start=output.indexOf('{',start+1)){let depth=0,quoted=false,escaped=false;for(let end=start;end<output.length;end++){const c=output[end];if(quoted){if(escaped)escaped=false;else if(c==='\\')escaped=true;else if(c==='"')quoted=false;}else if(c==='"')quoted=true;else if(c==='{')depth++;else if(c==='}'&&--depth===0){try{const item=JSON.parse(output.slice(start,end+1));if(item.verified===true)return Object.fromEntries(['verified','market','openTransactionHash','closeTransactionHash','tradeTransaction','closeTransaction','openingHedgeOrders','closingHedgeOrders','finalBase','finalCustomerBase','finalVenueBase'].filter(key=>key in item).map(key=>[key,item[key]]));}catch{}break;}}}
 throw new Error('Child succeeded without retained verified transaction evidence');
}
async function run(script:string,cycle:number){const at=performance.now();const output=await supervise('npm',['run',script],{cwd:resolve('.'),env:process.env,timeoutMs:childTimeoutMs,signal:abort.signal});report.results.push({cycle,script,durationMs:Math.round(performance.now()-at),evidence:verifiedEvidence(output)});checkpoint();}

checkpoint();
try{for(let cycle=1;!interrupted&&(hours>0||cycle<=cycles);cycle++){
 for(const script of ['smoke:base-sepolia-iteration-e2e','smoke:base-sepolia-iteration-hedge-e2e']){const at=Date.now();try{await run(script,cycle);}catch(error){report.failures++;report.results.push({cycle,script,durationMs:Date.now()-at,error:String(error)});throw error;}}
 report.completed=cycle;checkpoint();if((deadline&&performance.now()>=deadline)||(!hours&&cycle>=cycles))break;
 await new Promise<void>(done=>{const timer=setTimeout(done,deadline?Math.min(intervalMs,Math.max(0,deadline-performance.now())):intervalMs);wake=()=>{clearTimeout(timer);done();};}).finally(()=>{wake=undefined;});if(deadline&&performance.now()>=deadline)break;
 }report.status=interrupted?'interrupted':hours>0&&performance.now()<deadline?'incomplete':'completed';
}catch{report.status=interrupted?'interrupted':'failed';}finally{try{report.finalCandidateHash=identifyCandidate().candidateHash;report.finalDeploymentHash=createHash('sha256').update(readFileSync(deploymentPath)).digest('hex');if(report.finalCandidateHash!==report.candidateHash||report.finalDeploymentHash!==report.deploymentHash){report.status='failed';report.failures++;}}catch{report.status='failed';report.failures++;}checkpoint();}
console.log(JSON.stringify({passed:report.status==='completed'&&report.failures===0,report:destination,status:report.status,completed:report.completed},null,2));if(report.status!=='completed'||report.failures)process.exitCode=1;
