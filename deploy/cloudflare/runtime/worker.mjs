import { Container, getContainer, switchPort } from "@cloudflare/containers";
import { env } from "cloudflare:workers";
import { portForPath } from "./routing.mjs";

export class RFQRuntimeContainer extends Container {
  defaultPort=4100;
  requiredPorts=[4100,4201,4202,4203,4300,4400,4500];
  sleepAfter="24h";
  enableInternet=true;
  envVars={RFQ_RUNTIME_ENV_JSON:env.RFQ_RUNTIME_ENV_JSON};
}

const unavailable=()=>new Response(JSON.stringify({error:"route_not_found"}),{status:404,headers:{"content-type":"application/json; charset=utf-8","cache-control":"no-store"}});

export default {
  async fetch(request,workerEnv){
    const url=new URL(request.url),port=portForPath(url.pathname,request.method);
    if(port===null)return unavailable();
    const container=getContainer(workerEnv.RFQ_RUNTIME,"base-sepolia-primary");
    return container.fetch(switchPort(request,port));
  },
};
