import { serviceForPath } from "../static/web-edge.mjs";
export function portForPath(pathname, method) {
  return { API: 4100, INDEXER: 4300, MARKET_GATEWAY: 4500 }[serviceForPath(pathname, method)] ?? null;
}
const HEDGER_OPS = /^\/ops\/hedger(\/v1\/status(?:\/stream)?)$/;
/** The hedger path behind an operations dashboard route (GET /ops/hedger/v1/status[/stream]), else null. */
export function hedgerOpsPath(pathname, method) {
  return method === "GET" ? (HEDGER_OPS.exec(pathname)?.[1] ?? null) : null;
}
