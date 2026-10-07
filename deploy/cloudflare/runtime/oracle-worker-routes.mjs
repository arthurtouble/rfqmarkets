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

/** The launch markets a node prices when neither ORACLE_MARKETS nor a market registry is configured. */
export const DEFAULT_ORACLE_MARKETS = Object.freeze([
  { id: 0, symbol: "BTC" },
  { id: 1, symbol: "ETH" },
]);

/** Parses the worker's ORACLE_MARKETS var (`0:BTC,1:ETH,2:SOL`); unset means the launch markets. */
export function oracleWorkerMarkets(env) {
  const text = env.ORACLE_MARKETS?.trim();
  if (!text) return DEFAULT_ORACLE_MARKETS.map((market) => ({ ...market }));
  return text.split(",").map((entry) => {
    const [id, symbol] = entry.split(":").map((part) => part.trim());
    if (
      !/^\d+$/.test(id ?? "") ||
      Number(id) > 127 ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,30}$/.test(symbol ?? "")
    )
      throw new Error(`invalid ORACLE_MARKETS entry ${entry}`);
    return { id: Number(id), symbol };
  });
}

/**
 * The container's market env. With an ORACLE_RPC_URL secret and a clearing proxy in the deployment, the
 * node reads the clearing registry; otherwise it prices exactly the configured markets. ORACLE_MARKETS
 * (the worker var, else the launch markets) is always passed: with the registry it is the id:symbol
 * allowlist, so a node never signs for an index whose on-chain symbol differs from it (the signed price
 * carries only the index). A market governance adds is priced once it is added to the worker var.
 */
export function oracleNodeMarketEnv(env, deployment) {
  const markets = oracleWorkerMarkets(env),
    vars = { ORACLE_MARKETS: markets.map((market) => `${market.id}:${market.symbol}`).join(",") },
    rpcUrl = env.ORACLE_RPC_URL?.trim(),
    clearing = deployment?.contracts?.clearingProxy;
  if (rpcUrl && clearing) {
    vars.ORACLE_RPC_URL = rpcUrl;
    vars.ORACLE_CLEARING_ADDRESS = clearing;
  }
  return vars;
}

/** The markets whose candles to copy into history: what the node reports pricing, else the configured list. */
export function oracleSyncMarkets(health, fallback) {
  const reported = Array.isArray(health?.markets)
    ? health.markets
        .filter((item) => Number.isInteger(item?.market) && typeof item?.symbol === "string")
        .map((item) => ({ id: item.market, symbol: item.symbol }))
    : [];
  return reported.length ? reported : fallback;
}
