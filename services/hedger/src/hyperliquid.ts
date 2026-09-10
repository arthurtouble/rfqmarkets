import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { resolve } from "node:path";
import type { HedgeMarket, HedgeVenue, VenueOrder, VenueResult } from "./server.js";

type RpcReply={id:number;ok:boolean;result?:unknown;error?:string};
type Pending={resolve(value:unknown):void;reject(error:Error):void;timer:ReturnType<typeof setTimeout>};

export interface HyperliquidVenueOptions{
  accountAddress:string;
  agentPrivateKey:string;
  agentName?:string;
  apiUrl?:string;
  pythonPath?:string;
  bridgePath?:string;
  requestTimeoutMs?:number;
  minimumPerpUsdc?:string;
}

function assertAddress(value:string,name:string){if(!/^0x[0-9a-fA-F]{40}$/.test(value))throw new Error(`${name} must be a 20-byte hex address`);}
function assertPrivateKey(value:string){if(!/^0x[0-9a-fA-F]{64}$/.test(value))throw new Error("Hyperliquid agent key must be a 32-byte hex private key");}
function venueResult(value:unknown):VenueResult{
  const result=value as Partial<Record<keyof VenueResult,unknown>>;
  if(typeof result?.venueOrderId!=="string"||!(["open","partial","filled","rejected"] as unknown[]).includes(result.status)||typeof result.filledBase!=="string")throw new Error("invalid Hyperliquid bridge result");
  if(result.reason!==undefined&&typeof result.reason!=="string")throw new Error("invalid Hyperliquid bridge rejection reason");
  return {venueOrderId:result.venueOrderId,status:result.status as VenueResult["status"],filledBase:BigInt(result.filledBase),...(result.reason===undefined?{}:{reason:result.reason as string})};
}

/**
 * A persistent, private JSON-lines bridge to Hyperliquid's official Python SDK.
 * The child receives the agent key only through its environment and never logs it.
 */
export class HyperliquidVenue implements HedgeVenue{
  readonly mode="hyperliquid-testnet";
  private child?:ChildProcessWithoutNullStreams;
  private nextId=1;
  private pending=new Map<number,Pending>();
  private stdout="";
  private closed=false;
  private readonly apiUrl:string;
  private readonly pythonPath:string;
  private readonly bridgePath:string;
  private readonly timeoutMs:number;

  constructor(private readonly options:HyperliquidVenueOptions){
    assertAddress(options.accountAddress,"Hyperliquid account");assertPrivateKey(options.agentPrivateKey);
    this.apiUrl=options.apiUrl??"https://api.hyperliquid-testnet.xyz";
    if(this.apiUrl!=="https://api.hyperliquid-testnet.xyz")throw new Error("live hedge adapter is pinned to Hyperliquid testnet");
    if(!/^\d+(?:\.\d+)?$/.test(options.minimumPerpUsdc??"0"))throw new Error("minimum Hyperliquid perp USDC must be a non-negative decimal");
    this.pythonPath=options.pythonPath??resolve(".local-state/hyperliquid-venv/bin/python");
    this.bridgePath=options.bridgePath??resolve("services/hedger/hyperliquid_bridge.py");
    // The first request includes SDK import and metadata bootstrap. Steady-state
    // calls are much faster, but killing startup at ten seconds caused false
    // failures on the public testnet API.
    this.timeoutMs=options.requestTimeoutMs??30_000;
  }

  private start(){
    if(this.closed)throw new Error("Hyperliquid venue is closed");
    if(this.child&&this.child.exitCode===null)return this.child;
    const child=spawn(this.pythonPath,[this.bridgePath],{stdio:["pipe","pipe","pipe"],env:{...process.env,PYTHONUNBUFFERED:"1",RFQ_HYPERLIQUID_API_URL:this.apiUrl,RFQ_HYPERLIQUID_ACCOUNT_ADDRESS:this.options.accountAddress,RFQ_HYPERLIQUID_AGENT_KEY:this.options.agentPrivateKey,RFQ_HYPERLIQUID_AGENT_NAME:this.options.agentName??"",RFQ_HYPERLIQUID_MIN_PERP_USDC:this.options.minimumPerpUsdc??"0"}});
    this.child=child;this.stdout="";let stderr="";
    child.stdout.setEncoding("utf8");child.stderr.setEncoding("utf8");
    child.stderr.on("data",chunk=>{stderr=(stderr+String(chunk)).slice(-2_000)});
    child.stdout.on("data",chunk=>{this.stdout+=String(chunk);for(;;){const newline=this.stdout.indexOf("\n");if(newline<0)break;const line=this.stdout.slice(0,newline);this.stdout=this.stdout.slice(newline+1);if(!line)continue;let reply:RpcReply;try{reply=JSON.parse(line) as RpcReply;}catch{this.failAll(new Error("invalid JSON from Hyperliquid bridge"));child.kill();return;}const item=this.pending.get(reply.id);if(!item)continue;clearTimeout(item.timer);this.pending.delete(reply.id);if(reply.ok)item.resolve(reply.result);else item.reject(new Error(reply.error??"Hyperliquid bridge request failed"));}});
    child.on("exit",(code,signal)=>{if(this.child===child)this.child=undefined;this.failAll(new Error(`Hyperliquid bridge exited (${code??signal??"unknown"})${stderr?`: ${stderr}`:""}`));});
    child.on("error",error=>this.failAll(error));
    return child;
  }

  private failAll(error:Error){for(const item of this.pending.values()){clearTimeout(item.timer);item.reject(error);}this.pending.clear();}
  private request(method:string,params:Record<string,unknown>={}){
    const child=this.start(),id=this.nextId++;
    return new Promise<unknown>((resolveRequest,reject)=>{const timer=setTimeout(()=>{this.pending.delete(id);reject(new Error(`Hyperliquid ${method} timed out`));child.kill();},this.timeoutMs);this.pending.set(id,{resolve:resolveRequest,reject,timer});child.stdin.write(`${JSON.stringify({id,method,params})}\n`,error=>{if(error){clearTimeout(timer);this.pending.delete(id);reject(error);}});});
  }

  async verify(){return this.request("verify") as Promise<{accountAddress:string;agentAddress:string;agentName:string;validUntil:number;perpAccountValue:string;usablePerpUsdc:string;spotUsdc:string}>;}
  async position(market:HedgeMarket){const result=await this.request("position",{market}) as {base:string};return BigInt(result.base);}
  async find(clientId:string){const result=await this.request("find",{clientId});return result===null?null:venueResult(result);}
  async submit(order:VenueOrder){return venueResult(await this.request("submit",{clientId:order.clientId,market:order.market,baseDelta:order.baseDelta.toString(),limitPrice:order.limitPrice.toString()}));}
  async close(){const child=this.child;if(!child){this.closed=true;return;}try{await this.request("close");}catch{}this.closed=true;if(child.exitCode===null)child.kill();this.child=undefined;}
}
