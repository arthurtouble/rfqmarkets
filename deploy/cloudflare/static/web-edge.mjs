const ADDRESS = "0x[0-9a-fA-F]{40}";
const READS = [
  [new RegExp(`^/v1/account/${ADDRESS}/activity$`), "INDEXER"],
  [/^\/health$/, "INDEXER"],
  [/^\/v1\/(activity|positions|protocol|risk|updates\/stream)$/, "INDEXER"],
  [new RegExp(`^/v1/portfolio/${ADDRESS}(?:/(?:history|trades))?$`), "INDEXER"],
  [new RegExp(`^/v1/funding/${ADDRESS}$`), "INDEXER"],
  [/^\/v1\/markets\/(stream|history|stats)$/, "MARKET_GATEWAY"],
  [/^\/v1\/candles$/, "MARKET_GATEWAY"],
  [/^\/v1\/(config|markets)$/, "API"],
  [new RegExp(`^/v1/(account|orders)/${ADDRESS}$`), "API"],
];
const WRITES = [
  /^\/v1\/(quote|prepare|approve|orders)$/,
  /^\/v1\/(withdraw|session)\/(prepare|execute)$/,
  /^\/v1\/nonce\/cancel\/(prepare|execute)$/,
  /^\/v1\/close\/(prepare|execute|quote)$/,
  /^\/v1\/close\/all\/quote$/,
  /^\/v1\/orders\/(?:(?:trigger|tpsl)\/)?prepare$/,
  /^\/v1\/orders\/[A-Za-z0-9_-]{1,128}\/cancel(?:\/prepare)?$/,
];
export function serviceForPath(pathname, method) {
  const path=pathname.split("?",1)[0];
  if(!method || method === "GET" || method === "OPTIONS")for(const [pattern,service] of READS)if(pattern.test(path))return service;
  if(!method || method === "POST" || method === "OPTIONS")if(WRITES.some(pattern=>pattern.test(path)))return "API";
  return null;
}

function json(value, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      ...extraHeaders,
    },
  });
}

function requestId(request) {
  return request.headers.get("cf-ray") ?? crypto.randomUUID();
}

export async function handleRequest(request, env) {
  const url = new URL(request.url);
  if (url.pathname === "/edge/geo") {
    // The app asks once on load which mode to run in. The service routes below enforce it either way.
    const { status, country, region } = classifyLocation(request.cf);
    return json({ status, country, region, message: RESTRICTION_MESSAGE[status] ?? null });
  }
  if (url.pathname === "/edge/health") {
    return json({
      ok: true,
      edge: "ready",
      runtime: {
        api: Boolean(env.API),
        indexer: Boolean(env.INDEXER),
        marketGateway: Boolean(env.MARKET_GATEWAY),
      },
    });
  }

  const serviceName = serviceForPath(url.pathname,request.method);
  if (serviceName) {
    const location = classifyLocation(request.cf);
    if (!locationAllows(location, url.pathname, request.method)) {
      return json(
        { error: "jurisdiction_restricted", status: location.status, message: RESTRICTION_MESSAGE[location.status] },
        451,
        { vary: "cf-ipcountry" },
      );
    }
    const rejected=await admitAtEdge(request,env);if(rejected)return rejected;
    const id = requestId(request);
    const service = env[serviceName];
    if (!service || typeof service.fetch !== "function") {
      return json(
        { error: "service_unavailable", service: serviceName.toLowerCase(), requestId: id },
        503,
        { "retry-after": "5", "x-request-id": id },
      );
    }
    try {
      const headers = new Headers(request.headers);
      headers.set("x-request-id", id);
      const upstream = new Request(request, { headers });
      return await service.fetch(upstream);
    } catch {
      return json(
        { error: "upstream_unavailable", service: serviceName.toLowerCase(), requestId: id },
        503,
        { "retry-after": "1", "x-request-id": id },
      );
    }
  }

  if(url.pathname.startsWith("/v1/")||url.pathname.startsWith("/internal/")||url.pathname==="/approve")return json({error:"route_not_allowed"},404);
  if(request.method!=="GET"&&request.method!=="HEAD")return json({error:"method_not_allowed"},405);
  return env.ASSETS.fetch(request);
}

export default {
  fetch(request, env) {
    return handleRequest(request, env);
  },
};
import {admitAtEdge} from '../runtime/edge-admission.mjs';
import { RESTRICTION_MESSAGE, classifyLocation, locationAllows } from './jurisdictions.mjs';
