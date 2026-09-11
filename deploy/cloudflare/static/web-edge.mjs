const INDEXER_ROUTES = [
  /^\/health$/,
  /^\/v1\/(?:activity|positions|protocol|risk)(?:\/|$)/,
  /^\/v1\/updates\/stream$/,
];

const MARKET_GATEWAY_ROUTES = [
  /^\/v1\/markets\/stream$/,
  /^\/v1\/markets\/history(?:\/|$)/,
];

export function serviceForPath(pathname) {
  const path = pathname.split("?", 1)[0];
  if (MARKET_GATEWAY_ROUTES.some((pattern) => pattern.test(path))) return "MARKET_GATEWAY";
  if (INDEXER_ROUTES.some((pattern) => pattern.test(path))) return "INDEXER";
  if (path.startsWith("/v1/")) return "API";
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

  const serviceName = serviceForPath(url.pathname);
  if (serviceName) {
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

  return env.ASSETS.fetch(request);
}

export default {
  fetch(request, env) {
    return handleRequest(request, env);
  },
};
