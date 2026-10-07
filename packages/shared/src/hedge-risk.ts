import type { Market } from "./markets.js";
import { abs } from "./numeric.js";

export type HedgeRiskMode = "normal" | "guarded" | "reduce_only";
export type HedgeExecutionSignal = {
  estimatedCostBps: number;
  latencyMs: number;
  basisBps: number;
  depthUsdc: string;
  observedAtMs: number;
};
export type HedgeRiskSnapshot = {
  observedAtMs: number;
  healthy: boolean;
  indexedBlock: number;
  /** Per market symbol. A market the hedger does not report is treated as reduce-only. */
  markets: Partial<Record<Market, HedgeMarketRisk>>;
};
export type HedgeMarketRisk = {
  mode: HedgeRiskMode;
  gapNotional: string;
  bandUsdc: string;
  execution?: HedgeExecutionSignal;
  /** Why the market is reduce-only when it is not a venue condition, e.g. `"no_hedge_mapping"`. */
  reason?: string;
};
/**
 * A market's hedge mode: `normal` without a hedge source (development), reduce-only when the snapshot
 * does not cover the market (fail closed, e.g. a market added after the hedger's last report).
 */
export function hedgeModeOf(snapshot: HedgeRiskSnapshot | undefined, market: Market): HedgeRiskMode {
  if (!snapshot) return "normal";
  return snapshot.markets[market]?.mode ?? "reduce_only";
}
export interface HedgeRiskSource {
  latest(): Promise<HedgeRiskSnapshot>;
}

export type HedgeAdmission = {
  allowed: boolean;
  maxTradeNotional: bigint;
  canBuy: boolean;
  canSell: boolean;
};

export function hedgeAdmission(
  mode: HedgeRiskMode,
  currentExposure: bigint,
  delta: bigint,
  maxTradeNotional: bigint,
): HedgeAdmission {
  const reducing = currentExposure !== 0n && abs(currentExposure + delta) < abs(currentExposure);
  const canBuy = mode !== "reduce_only" || currentExposure < 0n;
  const canSell = mode !== "reduce_only" || currentExposure > 0n;
  return {
    allowed: mode !== "reduce_only" || reducing,
    maxTradeNotional: mode === "guarded" ? maxTradeNotional / 2n : maxTradeNotional,
    canBuy,
    canSell,
  };
}
