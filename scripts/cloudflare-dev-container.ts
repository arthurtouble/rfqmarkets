import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type IncomingMessage } from "node:http";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

// Entry point of the Cloudflare dev container. Container disk is ephemeral, so the Durable Object that
// owns the container keeps the SQLite journals: it restores them here before services start and pulls a
// consistent snapshot every minute. A restart can lose up to that minute; acceptable only for the dev profile.
const STATE=resolve(process.env.RFQ_DEV_RUNTIME_DIR??"/tmp/rfq-dev-runtime"),PORT=Number(process.env.RFQ_CONTROL_PORT??4099);
const JOURNAL=/^[a-z0-9-]+\.sqlite$/;
let child:ChildProcess|null=null,phase:"waiting"|"running"|"exited"="waiting",clearing:string|null=null,exitCode:number|null=null;

/** Consistent copies of every journal, base64-encoded, taken while the services keep writing. */
export function snapshotJournals(directory:string){
  const files:Record<string,string>={};if(!existsSync(directory))return files;
  for(const name of readdirSync(directory).filter(item=>JOURNAL.test(item))){
    const copy=join(directory,`.${name}.snapshot`);rmSync(copy,{force:true});
    const database=new DatabaseSync(join(directory,name),{readOnly:true});
    try{database.exec(`VACUUM INTO '${copy.replaceAll("'","''")}'`);}finally{database.close();}
    files[name]=readFileSync(copy).toString("base64");rmSync(copy,{force:true});
  }
  return files;
}

/** Writes restored journals into an empty state directory and checks each one opens cleanly. */
export function restoreJournals(directory:string,files:Record<string,string>){
  mkdirSync(directory,{recursive:true});
  if(readdirSync(directory).some(item=>JOURNAL.test(item)))throw new Error("state directory already holds journals; refusing to overwrite");
  for(const [name,data] of Object.entries(files)){
    if(!JOURNAL.test(name))throw new Error(`unexpected journal name ${name}`);
    const path=join(directory,name);writeFileSync(path,Buffer.from(data,"base64"),{mode:0o600});
    const database=new DatabaseSync(path,{readOnly:true});
    try{if((database.prepare("PRAGMA integrity_check").get() as {integrity_check?:string}|undefined)?.integrity_check!=="ok")throw new Error(`${name} failed its integrity check`);}finally{database.close();}
  }
}

const body=async(request:IncomingMessage)=>{const chunks:Buffer[]=[];for await(const chunk of request)chunks.push(chunk as Buffer);return JSON.parse(Buffer.concat(chunks).toString("utf8")||"{}");};
const reply=(response:import("node:http").ServerResponse,status:number,value:unknown)=>{response.writeHead(status,{"content-type":"application/json"});response.end(JSON.stringify(value));};

if(import.meta.url===`file://${process.argv[1]}`){
  createServer(async(request,response)=>{
    try{
      if(request.method==="GET"&&request.url==="/control/status")return reply(response,200,{phase,clearing,exitCode});
      if(request.method==="GET"&&request.url==="/control/snapshot")return reply(response,phase==="waiting"?409:200,phase==="waiting"?{error:"runtime has not started"}:{clearing,files:snapshotJournals(STATE)});
      if(request.method==="POST"&&request.url==="/control/start"){
        if(phase!=="waiting")return reply(response,409,{error:`runtime is ${phase}`});
        const input=await body(request) as {deployment:{contracts:{clearingProxy:string}};secrets:unknown;journals?:Record<string,string>|null};
        if(input.journals)restoreJournals(STATE,input.journals);
        clearing=input.deployment.contracts.clearingProxy;phase="running";
        child=spawn(process.execPath,["--import","tsx","scripts/base-mainnet-dev-stack.ts"],{stdio:"inherit",env:{...process.env,RFQ_BIND_HOST:"0.0.0.0",RFQ_DEV_RUNTIME_DIR:STATE,RFQ_DEV_DEPLOYMENT_JSON:JSON.stringify(input.deployment),RFQ_DEV_RUNTIME_SECRETS_JSON:JSON.stringify(input.secrets)}});
        child.once("exit",code=>{phase="exited";exitCode=code;});
        return reply(response,202,{phase,restored:Object.keys(input.journals??{})});
      }
      reply(response,404,{error:"not_found"});
    }catch(error){reply(response,500,{error:error instanceof Error?error.message:String(error)});}
  }).listen(PORT,"0.0.0.0",()=>console.log(`dev container control listening on ${PORT}`));
  process.on("SIGTERM",()=>{child?.kill("SIGTERM");setTimeout(()=>process.exit(0),4_000).unref();});
}
