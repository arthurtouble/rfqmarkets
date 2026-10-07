import { Container, getContainer, switchPort } from "@cloudflare/containers";
import { portForPath } from "./routing.mjs";
import { admitAtEdge } from "./edge-admission.mjs";
import { loadJournals, saveJournals } from "./dev-journal-store.mjs";
import { ensureIdentities, matchesDeployment, publicIdentities } from "./dev-identities.mjs";

// Base mainnet dev runtime: one container runs every service (scripts/cloudflare-dev-container.ts).
// The deployment record comes from the DEV_STATE KV namespace, written by the dev-contracts workflow.
// Approver, sponsor and emergency keys are generated and kept in this Durable Object's storage
// (dev-identities.mjs); RPC URLs and the Pyth key come from the RFQ_DEV_RUNTIME_SECRETS secret.
// Journals also live in Durable Object storage, keyed by proxy address, so a fresh contract
// deployment starts with empty journals.
const CONTROL=4099,INSTANCE="base-mainnet-dev",control=path=>`http://container${path}`;
const json=(value,status=200,headers={})=>new Response(JSON.stringify(value),{status,headers:{"content-type":"application/json; charset=utf-8","cache-control":"no-store",...headers}});

export class RFQDevRuntime extends Container {
  defaultPort=CONTROL;
  requiredPorts=[CONTROL];
  sleepAfter="720h";
  enableInternet=true;
  readyUntil=0;
  starting=null;

  async status(){return await (await this.containerFetch(control("/control/status"),CONTROL)).json();}

  ensureRunning(){
    if(Date.now()<this.readyUntil)return Promise.resolve({ready:true});
    this.starting??=this.start().finally(()=>{this.starting=null;});
    return this.starting;
  }

  /** Creates the runtime's keys on first use and publishes their addresses for the contracts workflow. */
  async identities(){
    const identities=await ensureIdentities(this.ctx.storage),published=JSON.stringify(publicIdentities(identities));
    if(await this.env.DEV_STATE.get("identities.json")!==published)await this.env.DEV_STATE.put("identities.json",published);
    return identities;
  }

  async start(){
    const identities=await this.identities(),text=await this.env.DEV_STATE.get("deployment.json");
    if(!text)return {ready:false,reason:"contracts_not_deployed"};
    if(!this.env.RFQ_DEV_RUNTIME_SECRETS)return {ready:false,reason:"runtime_secrets_missing"};
    const deployment=JSON.parse(text),clearing=deployment.contracts.clearingProxy.toLowerCase();
    if(!matchesDeployment(identities,deployment))return {ready:false,reason:"approver_keys_do_not_match_deployment"};
    const secrets={...JSON.parse(this.env.RFQ_DEV_RUNTIME_SECRETS),sponsorKey:identities.sponsor.privateKey,approverKeys:identities.approvers.map(item=>item.privateKey)};
    await this.startAndWaitForPorts(CONTROL);
    let status=await this.status();
    if(status.phase!=="waiting"&&(status.phase==="exited"||status.clearing?.toLowerCase()!==clearing)){
      // A crashed stack or a new deployment: keep the journals of what ran, then start clean.
      await this.snapshot();await this.destroy();await this.startAndWaitForPorts(CONTROL);status=await this.status();
    }
    if(status.phase==="waiting"){
      const journals=await loadJournals(this.ctx.storage,clearing);
      const started=await this.containerFetch(new Request(control("/control/start"),{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({deployment,secrets,journals})}),CONTROL);
      if(started.status!==202)return {ready:false,reason:`start_failed:${(await started.json()).error}`};
    }
    this.readyUntil=Date.now()+15_000;
    return {ready:true};
  }

  async snapshot(){
    const state=await this.getState();if(state.status!=="running"&&state.status!=="healthy")return {saved:false};
    const response=await this.containerFetch(control("/control/snapshot"),CONTROL);if(response.status!==200)return {saved:false};
    const {clearing,files}=await response.json();return {saved:true,...await saveJournals(this.ctx.storage,clearing,files)};
  }

  /** Cron: keeps the runtime up (the indexer and hedger must run between requests) and saves journals. */
  async tick(){const ready=await this.ensureRunning();return {...ready,...(ready.ready?await this.snapshot():{})};}

  async fetch(request){
    const ready=await this.ensureRunning();
    if(!ready.ready)return json({error:"runtime_unavailable",reason:ready.reason},503,{"retry-after":"30"});
    try{return await super.fetch(request);}catch{this.readyUntil=0;return json({error:"runtime_starting"},503,{"retry-after":"5"});}
  }
}

export default {
  async fetch(request,env){
    const url=new URL(request.url),port=portForPath(url.pathname,request.method);
    if(port===null)return json({error:"route_not_found"},404);
    const rejected=await admitAtEdge(request,env);if(rejected)return rejected;
    return getContainer(env.RFQ_DEV_RUNTIME,INSTANCE).fetch(switchPort(request,port));
  },
  async scheduled(_event,env,context){
    context.waitUntil(getContainer(env.RFQ_DEV_RUNTIME,INSTANCE).tick());
  },
};
