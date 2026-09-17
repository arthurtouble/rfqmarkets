import { adaptiveSpread, type PriceSnapshot } from "../../../packages/shared/src/policy.js";

export const YEAR = 365n * 24n * 60n * 60n;
export const RATE = 1_000_000_000_000n;
export const DEFAULT_TRADE_LIMIT = 1_000_000n * 1_000_000n;
export const DEFAULT_MARKET_LIMIT = 5_000_000n * 1_000_000n;

type RiskMode = "normal" | "guarded" | "reduce_only";
type ExecutionEstimate = { estimatedCostBps: number; latencyMs: number; basisBps: number };

export function abs(value: bigint) {
  return value < 0n ? -value : value;
}

export function decodeLimits(word: unknown) {
  const value = BigInt(word as bigint);
  return {
    maxTradeNotional: value & ((1n << 128n) - 1n),
    maxMarketNotional: value >> 128n,
  };
}

export function quoteSpread(
  snapshot: PriceSnapshot,
  riskMode: RiskMode = "normal",
  toxicityScoreBps = 0,
  execution?: ExecutionEstimate,
) {
  return adaptiveSpread({
    volatilityBps: snapshot.volatilityBps,
    riskMode,
    toxicityScoreBps,
    hedgeCostBps: execution?.estimatedCostBps,
    hedgeLatencyMs: execution?.latencyMs,
    venueBasisBps: execution?.basisBps,
  });
}

export function shadowQuoteSpread(
  snapshot: PriceSnapshot,
  riskMode: RiskMode,
  toxicityScoreBps: number,
  execution?: ExecutionEstimate,
) {
  return adaptiveSpread({
    volatilityBps: (snapshot.volatilityBps ?? 0) * 1.25,
    riskMode,
    toxicityScoreBps,
    hedgeCostBps: execution?.estimatedCostBps,
    hedgeLatencyMs: execution?.latencyMs,
    venueBasisBps: execution?.basisBps,
  });
}

export function errorText(error: unknown) {
  try {
    return `${String(error)} ${JSON.stringify(error)}`;
  } catch {
    return String(error);
  }
}

export function staleOracleFailure(error: unknown) {
  const text = errorText(error).toLowerCase();
  return text.includes("staleprice") || text.includes("0xd7815800") || text.includes("0x45805f5d");
}
