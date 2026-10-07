// Price protection the user allows on a quote or trigger order, in bps.
// Bounds mirror packages/shared (MIN/MAX_SLIPPAGE_BPS) and the API schemas.
import { MAX_SLIPPAGE_BPS, MIN_SLIPPAGE_BPS } from "../../../../packages/shared/src/pricing.js";

export { MAX_SLIPPAGE_BPS, MIN_SLIPPAGE_BPS };
/** POST /v1/quote default: the launch tolerance. */
export const DEFAULT_SLIPPAGE_BPS = 8;
/** POST /v1/orders/trigger/prepare and /tpsl/prepare default (1%). */
export const DEFAULT_TRIGGER_SLIPPAGE_BPS = 100;
/** Ticket presets, in bps. */
export const SLIPPAGE_PRESETS_BPS = [5, 8, 25, 50, 100] as const;

export const isValidSlippageBps = (bps: unknown): bps is number =>
  typeof bps === "number" && Number.isInteger(bps) && bps >= MIN_SLIPPAGE_BPS && bps <= MAX_SLIPPAGE_BPS;

/** A slippage value the API accepts: integer bps clamped to 1..500, or `fallback` when not a number. */
export function clampSlippageBps(bps: number | null | undefined, fallback = DEFAULT_SLIPPAGE_BPS): number {
  if (bps === null || bps === undefined || !Number.isFinite(bps)) return fallback;
  return Math.min(MAX_SLIPPAGE_BPS, Math.max(MIN_SLIPPAGE_BPS, Math.round(bps)));
}

/**
 * Parses a user-typed percentage ("0.08", "0.5%") into bps; null unless it is
 * a whole number of bps within 1..500 (0.01% .. 5%).
 */
export function parseSlippagePercent(text: string): number | null {
  const value = text.trim().replace(/%$/, "").trim();
  if (!/^\d+(\.\d{0,2})?$/.test(value) && !/^\.\d{1,2}$/.test(value)) return null;
  const bps = Math.round(Number(value) * 100);
  return isValidSlippageBps(bps) ? bps : null;
}

/** bps to a percentage string for an input ("0.08"). */
export const slippageToPercent = (bps: number) => (bps / 100).toFixed(2).replace(/\.?0+$/, "");
