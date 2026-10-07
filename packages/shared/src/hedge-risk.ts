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
  markets: Record<
    Market,
    { mode: HedgeRiskMode; gapNotional: string; bandUsdc: string; execution?: HedgeExecutionSignal }
  >;
};
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
