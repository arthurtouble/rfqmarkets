import assert from "node:assert/strict";
import http from "node:http";
import { performance } from "node:perf_hooks";

const target=new URL(process.env.RFQ_STREAM_URL??"http://127.0.0.1:4500/v1/markets/stream"),count=Number(process.env.RFQ_SSE_CLIENTS??1_000);
assert(Number.isInteger(count)&&count>0&&count<=100_000,"RFQ_SSE_CLIENTS must be between 1 and 100000");
const agent=new http.Agent({keepAlive:true,maxSockets:count}),requests:http.ClientRequest[]=[];let frames=0,errors=0;
function connect(){return new Promise<void>(resolve=>{let delivered=false,settled=false;const done=(failed=false)=>{if(settled)return;settled=true;if(failed)errors++;resolve();};const request=http.get(target,{agent,headers:{accept:"text/event-stream"}},response=>{let buffer="";response.setEncoding("utf8");response.on("data",chunk=>{if(delivered)return;buffer+=chunk;if(buffer.includes("event: markets")&&buffer.includes("\n\n")){delivered=true;frames++;done();}});});requests.push(request);request.setTimeout(15_000,()=>{request.destroy();done(true);});request.on("error",()=>done(true));});}
const started=performance.now();await Promise.all(Array.from({length:count},()=>connect()));const connectMs=performance.now()-started;assert.equal(errors,0,`${errors} stream connections failed`);assert.equal(frames,count,`${count-frames} clients did not receive a complete frame`);
for(let index=0;index<requests.length;index+=2)requests[index].destroy();await new Promise(resolve=>setTimeout(resolve,100));
const reconnectStarted=performance.now(),reconnects=Math.ceil(count/2);await Promise.all(Array.from({length:reconnects},()=>connect()));const reconnectMs=performance.now()-reconnectStarted;assert.equal(errors,0,"reconnect storm produced failures");
for(const request of requests)request.destroy();agent.destroy();
console.log(JSON.stringify({clients:count,initialConnectMs:Math.round(connectMs),initialConnectionsPerSecond:Math.round(count*1_000/connectMs),reconnects,reconnectMs:Math.round(reconnectMs),cachedFramesDelivered:frames},null,2));
