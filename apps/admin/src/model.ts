// What the hedge operations dashboard reads and how it turns it into what an operator sees.
// Two read-only feeds: the indexer's finalized risk view (GET /v1/risk?finalized=true) and the hedger's
// status stream (GET /v1/status/stream, services/hedger/src/server.ts). Pure functions only, so they are
// unit-tested without a browser.

/** Customer exposure per market from the indexer. Base amounts have 18 decimals, collateral 6 (USDC). */
export type RiskSnapshot = {
  indexedBlock: number;
  accountCount: number;
  totalCollateral: string;
  markets: Record<
    string,
    { longBase: string; shortBase: string; netBase: string; longAccounts: number; shortAccounts: number }
  >;
};

export type HedgeState = "within_band" | "hedge_required" | "unhedged";
export type TradingMode = "normal" | "guarded" | "reduce_only";

/** One market in the hedger's status. Notional and band are USDC (6 decimals). */
export type HedgeMarket = {
  customerBase: string;
  venueBase: string;
  gapBase: string;
  gapNotional: string;
  bandUsdc: string;
  coin?: string | null;
  state: HedgeState;
  /** Older hedgers do not report it. */
  tradingMode?: TradingMode;
  executionError?: string;
};

/** A row of the hedger's order journal. Limit price is USDC (6 decimals), sizes 18 decimals. */
export type HedgeOrder = {
  client_id: string;
  market: string;
  target_block: number;
  base_delta: string;
  limit_price: string;
  status: string;
  venue_order_id?: string | null;
  filled_base?: string;
  reason?: string | null;
  created_ms?: number;
  updated_ms?: number;
};

export type HedgeStatus = {
  mode: string;
  indexedBlock: number;
  /** When the hedger last read exposure successfully; 0 before its first success. */
  observedAtMs: number;
  healthy: boolean;
  error?: string;
  markets: Record<string, HedgeMarket>;
  orders: HedgeOrder[];
};

/** A failed read, in words an operator can act on. */
export function failureMessage(source: "hedger" | "indexer", status: number, body = ""): string {
  let code = "";
  try {
    const parsed = JSON.parse(body) as { error?: unknown; reason?: unknown };
    code = [parsed.error, parsed.reason].filter((part) => typeof part === "string").join(": ");
  } catch {}
  const name = source === "hedger" ? "Hedger" : "Indexer";
  if (status === 401 || status === 403)
    return code === "edge_identity_missing"
      ? `${name} refused the read: the request reached the runtime without a client IP.`
      : `${name} refused the read (${status}). Sign in again or check the operations token.`;
  if (code.startsWith("runtime_unavailable"))
    return `The dev runtime is not running (${code.replace("runtime_unavailable: ", "")}).`;
  if (code === "runtime_starting" || code === "upstream_unavailable") return `${name} is starting. Retrying.`;
  if (status === 429) return `${name} is rate limiting this dashboard. Retrying.`;
  return `${name} answered ${status}${code ? ` (${code})` : ""}. Retrying.`;
}

export type Tone = "ok" | "warn" | "bad" | "idle";
export type FeedHealth = { tone: Tone; label: string; detail?: string };

/**
 * The header's status: whether the hedger is connected, reading exposure and fresh.
 * `staleMs` matches the hedger's own staleness limit on the dev runtime.
 */
export function feedHealth(
  hedge: HedgeStatus | undefined,
  connection: { connected: boolean; error?: string },
  now: number,
  staleMs = 10_000,
): FeedHealth {
  if (!hedge)
    return connection.error
      ? { tone: "bad", label: "Offline", detail: connection.error }
      : { tone: "idle", label: "Connecting" };
  if (!connection.connected)
    return { tone: "bad", label: "Reconnecting", detail: connection.error ?? "Hedger stream closed." };
  if (!hedge.healthy) {
    const detail = hedge.error
      ? cleanError(hedge.error)
      : hedge.observedAtMs
        ? `No exposure read for ${duration(now - hedge.observedAtMs)}.`
        : "Waiting for the first exposure read.";
    return { tone: "bad", label: "Degraded", detail };
  }
  if (hedge.observedAtMs && now - hedge.observedAtMs > staleMs)
    return { tone: "warn", label: "Stale", detail: `Last exposure read ${duration(now - hedge.observedAtMs)} ago.` };
  return { tone: "ok", label: "Live" };
}

/** Strips JavaScript error prefixes ("Error: indexer unavailable: ...") from a reported error. */
export function cleanError(error: string) {
  const text = error.replace(/^(?:\w*(?:Error|Exception|Unavailable):\s*)+/, "").trim();
  return text ? text[0].toUpperCase() + text.slice(1) : "Unknown error";
}

export function duration(ms: number) {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return hours < 48 ? `${hours}h ${minutes % 60}m` : `${Math.floor(hours / 24)}d`;
}

export type MarketView = {
  symbol: string;
  risk?: RiskSnapshot["markets"][string];
  hedge?: HedgeMarket;
  /** Share of customer gross exposure that is long, 0-100, or undefined with no exposure. */
  longShare?: number;
  /** Gap notional as a share of the action band, 0-100+ (undefined without a band). */
  bandUse?: number;
};

/** Every market either feed reports, in the hedger's order (the chain's market order), then the indexer's. */
export function marketViews(risk: RiskSnapshot | undefined, hedge: HedgeStatus | undefined): MarketView[] {
  const symbols = [...new Set([...Object.keys(hedge?.markets ?? {}), ...Object.keys(risk?.markets ?? {})])];
  return symbols.map((symbol) => {
    const r = risk?.markets[symbol],
      h = hedge?.markets[symbol];
    const gross = r ? BigInt(r.longBase) + BigInt(r.shortBase) : 0n;
    const band = h ? BigInt(h.bandUsdc) : 0n;
    return {
      symbol,
      risk: r,
      hedge: h,
      longShare: gross > 0n ? Number((BigInt(r!.longBase) * 10_000n) / gross) / 100 : undefined,
      bandUse: h && band > 0n ? Number((BigInt(h.gapNotional) * 10_000n) / band) / 100 : undefined,
    };
  });
}

/** Sum of the gap notional across markets (USDC, 6 decimals). */
export function totalGap(hedge: HedgeStatus | undefined) {
  return Object.values(hedge?.markets ?? {}).reduce((sum, market) => sum + BigInt(market.gapNotional), 0n);
}

/** Counts of markets needing attention: outside the band, or with no hedge venue. */
export function attention(hedge: HedgeStatus | undefined) {
  const markets = Object.values(hedge?.markets ?? {});
  return {
    hedgeRequired: markets.filter((market) => market.state === "hedge_required").length,
    unhedged: markets.filter((market) => market.state === "unhedged").length,
    restricted: markets.filter((market) => market.tradingMode && market.tradingMode !== "normal").length,
  };
}

export const STATE_LABEL: Record<HedgeState, string> = {
  within_band: "Within band",
  hedge_required: "Hedge required",
  unhedged: "No hedge venue",
};
export const MODE_LABEL: Record<TradingMode, string> = {
  normal: "Open for trading",
  guarded: "Guarded",
  reduce_only: "Reduce-only",
};
