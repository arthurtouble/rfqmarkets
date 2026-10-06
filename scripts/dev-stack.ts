// One command for the whole local venue: compile, chain, deploy, services.
// Usage: npm run dev:stack [-- --web] [-- --coinbase] [-- --skip-compile]
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdirSync, openSync } from "node:fs";

const args=new Set(process.argv.slice(2));
const rpcUrl="http://127.0.0.1:8545";
const children:ChildProcess[]=[];
let stopping=false;

const run=(script:string,env:NodeJS.ProcessEnv={})=>{
  const result=spawnSync("npm",["run","--silent",script],{stdio:"inherit",env:{...process.env,...env}});
  if(result.status!==0)throw new Error(`npm run ${script} failed with ${result.status}`);
};
const start=(label:string,script:string,env:NodeJS.ProcessEnv={},logFile?:string)=>{
  const output=logFile?openSync(logFile,"w"):"inherit";
  const child=spawn("npm",["run","--silent",script],{stdio:["ignore",output,output],env:{...process.env,...env},detached:true});
  child.on("exit",code=>{if(!stopping){console.error(`${label} exited with ${code}; stopping the stack`);void stop(1);}});
  children.push(child);return child;
};
const stop=async(code=0)=>{
  if(stopping)return;stopping=true;
  for(const child of [...children].reverse())if(child.pid&&child.exitCode===null)try{process.kill(-child.pid,"SIGTERM");}catch{}
  await new Promise(done=>setTimeout(done,1_500));
  for(const child of children)if(child.pid&&child.exitCode===null)try{process.kill(-child.pid,"SIGKILL");}catch{}
  process.exit(code);
};
process.on("SIGINT",()=>void stop());process.on("SIGTERM",()=>void stop());

const waitForRpc=async()=>{
  for(let attempt=0;attempt<100;attempt++){
    try{const response=await fetch(rpcUrl,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({jsonrpc:"2.0",id:1,method:"eth_chainId",params:[]}),signal:AbortSignal.timeout(500)});if(response.ok)return;}catch{}
    await new Promise(done=>setTimeout(done,200));
  }
  throw new Error(`local chain did not answer at ${rpcUrl}`);
};
const waitForHttp=async(url:string)=>{
  for(let attempt=0;attempt<150;attempt++){try{if((await fetch(url,{signal:AbortSignal.timeout(500)})).ok)return;}catch{}await new Promise(done=>setTimeout(done,200));}
  throw new Error(`${url} did not become ready`);
};

try{
  if(!args.has("--skip-compile"))run("compile:contracts");
  mkdirSync(".local-state",{recursive:true});
  start("chain","dev:chain",{},".local-state/chain.log");
  await waitForRpc();
  run("deploy:local");
  start("services","dev:services",{RFQ_MARKET_DATA:args.has("--coinbase")?"coinbase":"sim"});
  await waitForHttp("http://127.0.0.1:4100/health");
  if(args.has("--web"))start("web","dev:web");
  console.log("\nLocal stack is up. Chain :8545 (log in .local-state/chain.log), API :4100. Try `npm run dev:scenario` in another terminal. Ctrl-C stops everything.\n");
}catch(error){
  console.error((error as Error).message);await stop(1);
}
