// Public surface of an oracle node worker (oracle-worker.mjs), kept free of Cloudflare imports for tests.
const NODE_PATHS = new Set(["/health", "/v1/batch/latest", "/v1/batch/stream"]),
  HISTORY_PATHS = new Set(["/v1/history/candles", "/v1/history/batches"]);
export const LOCATION_HINTS = ["wnam", "enam", "sam", "weur", "eeur", "apac", "oc", "afr", "me"];

/** "node" (proxied to the container), "history" (Durable Object SQLite), "method" (not GET), or null. */
export function oracleRequestRoute(request) {
  const { pathname } = new URL(request.url),
    known = NODE_PATHS.has(pathname) ? "node" : HISTORY_PATHS.has(pathname) ? "history" : null;
  if (!known) return null;
  return request.method === "GET" || request.method === "HEAD" ? known : "method";
}

/** Which node this worker is (1-3) and where its Durable Object should live. */
export function oracleWorkerSettings(env) {
  const index = Number(env.ORACLE_NODE_INDEX),
    locationHint = env.ORACLE_LOCATION_HINT;
  if (![1, 2, 3].includes(index)) throw new Error("ORACLE_NODE_INDEX must be 1, 2 or 3");
  if (!LOCATION_HINTS.includes(locationHint)) throw new Error("ORACLE_LOCATION_HINT is not a location hint");
  return { index, instance: `oracle-node-${index}`, locationHint };
}
