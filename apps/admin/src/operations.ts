import { useEffect, useState } from "react";

export type Market = "BTC" | "ETH";
export type Risk = { indexedBlock:number; accountCount:number; totalCollateral:string; markets:Record<Market,{longBase:string;shortBase:string;netBase:string;longAccounts:number;shortAccounts:number}> };
export type HedgeOrder = {client_id:string;market:string;base_delta:string;limit_price:string;status:string;target_block:string|number};
export type Hedge = {mode:string;indexedBlock:number;observedAtMs:number;healthy:boolean;error?:string;markets:Record<Market,{customerBase:string;venueBase:string;gapBase:string;gapNotional:string;bandUsdc:string;state:string}>;orders:HedgeOrder[]};

const INDEXER=import.meta.env.VITE_INDEXER_URL??(import.meta.env.DEV?"http://127.0.0.1:4300":"");
const HEDGER=import.meta.env.VITE_HEDGER_URL??(import.meta.env.DEV?"http://127.0.0.1:4400":"");
const HEDGE_TOKEN=import.meta.env.VITE_HEDGE_OPS_TOKEN??(import.meta.env.DEV?"local-development-hedge-token":undefined);
const hedgeHeaders:Record<string,string>=HEDGE_TOKEN?{authorization:`Bearer ${HEDGE_TOKEN}`}:{ };

export const decimal=(value:string,decimals:number,digits=3)=>new Intl.NumberFormat("en-US",{maximumFractionDigits:digits}).format(Number(BigInt(value))/10**decimals);
export const usd=(value:string)=>new Intl.NumberFormat("en-US",{style:"currency",currency:"USD",maximumFractionDigits:0}).format(Number(BigInt(value))/1e6);

function consumeEvents(buffer:string){
  const frames=buffer.split("\n\n"),remainder=frames.pop()??"";
  const payloads=frames.flatMap(frame=>{const data=frame.split("\n").find(line=>line.startsWith("data: "))?.slice(6);return data?[data]:[];});
  return {payloads,remainder};
}

export function useOperationsData(){
  const[risk,setRisk]=useState<Risk>(),[hedge,setHedge]=useState<Hedge>(),[error,setError]=useState<string>();
  useEffect(()=>{
    let active=true;const controller=new AbortController();
    const loadRisk=async()=>{try{const response=await fetch(`${INDEXER}/v1/risk?finalized=true`);if(!response.ok)throw new Error("Finalized exposure unavailable");if(active){setRisk(await response.json() as Risk);setError(undefined);}}catch(reason){if(active)setError(String(reason));}};
    const streamHedge=async()=>{while(active){try{
      const response=await fetch(`${HEDGER}/v1/status/stream`,{headers:hedgeHeaders,credentials:HEDGE_TOKEN?"omit":"include",signal:controller.signal});
      if(!response.ok||!response.body)throw new Error(`Hedge stream ${response.status}`);
      const reader=response.body.getReader(),decoder=new TextDecoder();let buffer="";
      while(active){const{done,value}=await reader.read();if(done)break;buffer+=decoder.decode(value,{stream:true});const parsed=consumeEvents(buffer);buffer=parsed.remainder;for(const payload of parsed.payloads){setHedge(JSON.parse(payload) as Hedge);setError(undefined);}}
      if(active)throw new Error("Hedge stream closed");
    }catch(reason){if(!active)return;setError(String(reason));await new Promise(resolve=>setTimeout(resolve,1_000));}}};
    void loadRisk();void streamHedge();const indexStream=new EventSource(`${INDEXER}/v1/updates/stream`);indexStream.addEventListener("indexed",()=>void loadRisk());indexStream.onerror=()=>active&&setError("Indexer stream reconnecting");
    return()=>{active=false;controller.abort();indexStream.close();};
  },[]);
  return {risk,hedge,error};
}
