import {getAddress,keccak256,toUtf8Bytes} from 'ethers';

export interface KeeperState {resolutionRequired:boolean;resolutionPricesReady:boolean;resolutionFinalized:boolean;resolutionCursor:bigint;sampleCounts:[number,number];priceTimes:[number,number];timestamp:number}
export interface KeeperAccount {account:string;positions:{BTC:{size:string};ETH:{size:string}}}
export interface KeeperProof {report:string;observedAt:number;validUntil:number}
export type KeeperAction={kind:'refresh'|'sample';market:0|1;proof:KeeperProof}|{kind:'liquidate';market:0|1;account:string;proof:KeeperProof}|{kind:'process';cursor:bigint;maxAccounts:number}|{kind:'incident'};
export interface KeeperDependencies {
 reconcile():Promise<boolean>;
 state():Promise<KeeperState>;
 proof(market:0|1):Promise<KeeperProof>;
 accounts(cursor:string|undefined,limit:number):Promise<{items:KeeperAccount[];nextCursor:string|null}>;
 // False means an explicit canonical simulation revert. Transport failures throw.
 execute(id:string,action:KeeperAction):Promise<boolean>;
}

/** One writer, bounded work, with chain state re-read after every financial write. */
export class KeeperEngine {
 private running?:Promise<void>;
 private cursor?:string;
 private stopped=false;
 private error?:string;
 private completedAt?:number;
 constructor(private deps:KeeperDependencies,private limits={accountsPerCycle:25,maxTransactions:4,resolutionPage:50}) {
  for(const [name,value] of Object.entries(limits))if(!Number.isInteger(value)||value<1||value>200)throw new Error(`invalid keeper ${name}`);
 }
 status(){return {ok:!this.error&&!this.stopped&&this.completedAt!==undefined&&Date.now()-this.completedAt<30_000,lastCompletedAt:this.completedAt,error:this.error,running:!!this.running};}
 cycle(){if(this.stopped)return Promise.resolve();if(this.running)return this.running;
  this.running=this.run().then(()=>{this.error=undefined;this.completedAt=Date.now();}).catch(()=>{this.error='keeper_cycle_failed';}).finally(()=>{this.running=undefined;});return this.running;
 }
 async close(){this.stopped=true;await this.running;}
 private async run(){
  if(!await this.deps.reconcile())throw new Error('unresolved keeper sponsor');
  let state=await this.deps.state(),writes=0;
  const execute=async(action:KeeperAction)=>{
   if(this.stopped||writes>=this.limits.maxTransactions)return false;
   const payload=JSON.stringify(action,(_,value)=>typeof value==='bigint'?value.toString():value);
   const accepted=await this.deps.execute(`keeper:${keccak256(toUtf8Bytes(payload))}`,action);
   if(accepted){writes++;state=await this.deps.state();}return accepted;
  };
  const proof=async(market:0|1)=>{const item=await this.deps.proof(market);if(item.observedAt>state.timestamp+2||item.observedAt<state.timestamp-15||item.validUntil<state.timestamp+4)throw new Error('keeper proof lacks safe inclusion time');return item;};
  if(state.resolutionFinalized)return;
  if(state.resolutionRequired){
   if(state.resolutionPricesReady){await execute({kind:'process',cursor:state.resolutionCursor,maxAccounts:this.limits.resolutionPage});return;}
   for(const market of [0,1] as const){if(state.sampleCounts[market]<3&&writes<this.limits.maxTransactions)await execute({kind:'sample',market,proof:await proof(market)});}
   return;
  }
  // Both legs must be fresh before cross-margin liquidation, including at zero net.
  for(const market of [0,1] as const){if(state.timestamp-state.priceTimes[market]>5){await execute({kind:'refresh',market,proof:await proof(market)});if(state.resolutionRequired||this.stopped)return;}}
  if(writes>=this.limits.maxTransactions)return;
  if(state.priceTimes.some(time=>state.timestamp-time>15))throw new Error('keeper could not refresh cross-market prices');
  await execute({kind:'incident'});if(state.resolutionRequired||this.stopped)return;
  const page=await this.deps.accounts(this.cursor,this.limits.accountsPerCycle);
  if(page.items.length>this.limits.accountsPerCycle)throw new Error('oversized keeper page');
  for(let index=0;index<page.items.length;index++){
   if(this.stopped||writes>=this.limits.maxTransactions)return;
   const item=page.items[index],account=getAddress(item.account);
   if(this.cursor&&account<=this.cursor)throw new Error('nonmonotonic keeper page');
   const market=BigInt(item.positions.BTC.size)!==0n?0:BigInt(item.positions.ETH.size)!==0n?1:undefined;
   if(market!==undefined)await execute({kind:'liquidate',account,market,proof:await proof(market)});
   this.cursor=account;
   if(state.resolutionRequired)return;
  }
  if(!page.nextCursor)this.cursor=undefined;
  else if(page.nextCursor!==this.cursor)throw new Error('inconsistent keeper cursor');
 }
}
