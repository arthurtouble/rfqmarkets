import type { ApproverPayload } from "../../../packages/shared/src/approver-payload.js";
import { isPositionReduction } from "../../../packages/shared/src/exposure-admission.js";
import {
  hedgeAdmission,
  type HedgeRiskMode,
  type HedgeRiskSnapshot,
} from "../../../packages/shared/src/hedge-risk.js";
import type { Market } from "../../../packages/shared/src/markets.js";
import { low128 } from "../../../packages/shared/src/numeric.js";
import type { HedgeRiskConfig } from "./options.js";
import { reject, type Rejection } from "./rejection.js";

export const HEDGE_RISK_TIMEOUT_MS = 500;
export const DEFAULT_HEDGE_RISK_MAX_AGE_MS = 3_000;
/** Basis-spread requirement is capped like the adaptive spread's basis component. */
const MAX_REQUIRED_BASIS_BPS = 25;

/** Fetch the hedger's risk snapshot. Throws on transport failure or a non-2xx response. */
export async function fetchHedgeRisk(
  config: HedgeRiskConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<HedgeRiskSnapshot> {
  const response = await fetchImpl(config.url, {
    headers: { authorization: `Bearer ${config.token}` },
    signal: AbortSignal.timeout(HEDGE_RISK_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`hedge risk HTTP ${response.status}`);
  return (await response.json()) as HedgeRiskSnapshot;
}

/** An unhealthy, missing or stale snapshot fails closed to reduce-only. */
export function effectiveHedgeMode(
  risk: HedgeRiskSnapshot,
  market: Market,
  nowMs: number,
  maxAgeMs = DEFAULT_HEDGE_RISK_MAX_AGE_MS,
): HedgeRiskMode {
  const reported = risk.markets[market]?.mode ?? "reduce_only";
  return !risk.healthy || !risk.observedAtMs || nowMs - risk.observedAtMs > maxAgeMs
    ? "reduce_only"
    : reported;
}

/**
 * Hedge-risk admission: reduce-only and guarded modes limit new exposure, and
 * the quote's hedge and basis spread components must cover the venue's
 * reported execution cost.
 */
export function checkHedgeRisk(input: {
  risk: HedgeRiskSnapshot;
  market: Market;
  nowMs: number;
  maxAgeMs?: number;
  aggregateBase: bigint;
  positionSize: bigint;
  delta: bigint;
  limitWord: bigint;
  executionNotional: bigint;
  spread: ApproverPayload["quote"]["spread"];
}): Rejection | undefined {
  const { risk, market, spread } = input;
  const marketRisk = risk.markets[market],
    mode = effectiveHedgeMode(risk, market, input.nowMs, input.maxAgeMs),
    admission = hedgeAdmission(mode, input.aggregateBase, input.delta, low128(input.limitWord));
  if (!admission.allowed) return reject("hedge risk requires exposure reduction");
  if (
    input.executionNotional > admission.maxTradeNotional &&
    !(mode === "normal" && isPositionReduction(input.positionSize, input.delta))
  )
    return reject("guarded hedge limit exceeded");
  if (spread && marketRisk?.execution) {
    const requiredHedge = BigInt(Math.max(0, Math.ceil(marketRisk.execution.estimatedCostBps))),
      requiredBasis = BigInt(
        Math.ceil(Math.min(MAX_REQUIRED_BASIS_BPS, Math.abs(marketRisk.execution.basisBps))),
      );
    if (BigInt(spread.hedgeBps) < requiredHedge || BigInt(spread.basisBps) < requiredBasis)
      return reject("venue execution spread rejected");
  }
}
