import { accessDenied, verifyAccess } from "./access.mjs";

// Edge for the private dev surfaces: the hedge operations dashboard (apps/admin) and the internal docs.
// Every request, assets included (run_worker_first), must carry a valid Cloudflare Access token for this
// application. The dashboard's reads go to the dev runtime through the RUNTIME service binding: the indexer's
// finalized risk view and update stream, the API's venue config (chain and clearing address, for the market
// controls), and the hedger's status under /ops/hedger, which the runtime answers with its own operations token
// so the browser never holds one. Only GET is allowed: market changes are transactions the operator's own
// wallet signs and sends, never requests through this edge.
const RUNTIME_READS = [/^\/v1\/risk$/, /^\/v1\/updates\/stream$/, /^\/v1\/config$/, /^\/ops\/hedger\/v1\/status(?:\/stream)?$/];

const json = (value, status) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" },
  });

// Mirrors apps/admin/public/_headers, which Workers does not apply to responses that pass through the worker.
const SECURITY_HEADERS = {
  "content-security-policy":
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'",
  "permissions-policy": "camera=(), geolocation=(), microphone=(), payment=(), usb=()",
  "referrer-policy": "no-referrer",
  "strict-transport-security": "max-age=31536000; includeSubDomains",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
};

export function runtimeRead(pathname) {
  return RUNTIME_READS.some((pattern) => pattern.test(pathname));
}

export async function handlePrivateRequest(request, env, options) {
  if (!(await verifyAccess(request, env, options))) return accessDenied(env);
  if (request.method !== "GET" && request.method !== "HEAD") return json({ error: "method_not_allowed" }, 405);
  const url = new URL(request.url);
  if (env.RUNTIME && runtimeRead(url.pathname)) {
    const headers = new Headers({ accept: request.headers.get("accept") ?? "*/*" });
    headers.set("x-request-id", request.headers.get("cf-ray") ?? crypto.randomUUID());
    // The runtime's edge admission rate-limits indexer reads per client IP and refuses requests without one
    // (deploy/cloudflare/runtime/edge-admission.mjs), so the operator's IP goes along.
    const client = request.headers.get("cf-connecting-ip");
    if (client) headers.set("cf-connecting-ip", client);
    // The Access token and cookies stay at the edge; the runtime sees only the path, query and client IP.
    try {
      return await env.RUNTIME.fetch(new Request(url, { method: "GET", headers, signal: request.signal }));
    } catch {
      return json({ error: "upstream_unavailable" }, 503);
    }
  }
  if (url.pathname.startsWith("/v1/") || url.pathname.startsWith("/ops/")) return json({ error: "route_not_allowed" }, 404);
  const asset = await env.ASSETS.fetch(request), response = new Response(asset.body, asset);
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) response.headers.set(name, value);
  // Private pages must not sit in shared caches.
  response.headers.set("cache-control", "private, no-store");
  return response;
}

export default {
  fetch(request, env) {
    return handlePrivateRequest(request, env);
  },
};
