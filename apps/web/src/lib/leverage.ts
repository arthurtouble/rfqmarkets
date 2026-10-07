// Leverage and margin helpers for the order ticket. Margin follows the
// contract's tiers scaled per market (RFQRiskMath.scaledMarginRate, mirrored in
// packages/shared), so a 0.25x scale turns the 20% first tier into 5% (20x).
import { DEFAULT_MARGIN_SCALE_BPS, legMargin, marketMarginView, scaledMarginRate } from "../../../../packages/shared/src/pricing.js";
import type { MarketMargin } from "./types.js";

export { DEFAULT_MARGIN_SCALE_BPS, legMargin, scaledMarginRate };

/** Leverage is handled in hundredths (2.5x = 250) so sizing stays in integers. */
const HUNDREDTHS = 100n;
const toHundredths = (leverage: number) => BigInt(Math.floor(leverage * 100 + 1e-9));

/** Margin parameters for a scale, as the API reports them (`marketMarginView`). */
export const marginForScale = (scaleBps: number = DEFAULT_MARGIN_SCALE_BPS): MarketMargin => marketMarginView(scaleBps);

/**
 * Order notional (USDC 1e6) for `marginMicro` of margin at `leverage`
 * (rounded down to 0.01x). Zero for non-positive or non-finite input.
 */
export function sizeFromLeverage(marginMicro: bigint, leverage: number): bigint {
  if (marginMicro <= 0n || !Number.isFinite(leverage) || leverage <= 0) return 0n;
  return marginMicro * toHundredths(leverage) / HUNDREDTHS;
}

/** Margin (USDC 1e6, rounded up) that `notionalMicro` uses at `leverage`. */
export function marginFromLeverage(notionalMicro: bigint, leverage: number): bigint {
  const hundredths = toHundredths(leverage);
  if (notionalMicro <= 0n || hundredths <= 0n) return 0n;
  return (notionalMicro * HUNDREDTHS + hundredths - 1n) / hundredths;
}

/**
 * Leverage the tiered initial margin allows at `notionalMicro`, rounded down
 * to 0.01x. Larger orders sit in higher tiers, so this falls as size grows; at
 * zero it equals the market's `maxLeverage`.
 */
export function maxLeverageAt(notionalMicro: bigint, scaleBps: number = DEFAULT_MARGIN_SCALE_BPS): number {
  return Number(1_000_000n / scaledMarginRate(notionalMicro < 0n ? -notionalMicro : notionalMicro, true, scaleBps)) / 100;
}

/** Clamps a requested leverage to [1, max] (or max itself when it is below 1). */
export function clampLeverage(leverage: number, maxLeverage: number): number {
  if (!Number.isFinite(leverage)) return Math.min(1, maxLeverage);
  return Math.max(Math.min(1, maxLeverage), Math.min(leverage, maxLeverage));
}

export const DEFAULT_LEVERAGE_PRESETS = [2, 5, 10] as const;

/**
 * Preset buttons for a market: the standard steps strictly below its max,
 * then the max itself, e.g. [2, 5, 10, 20] at 20x and [2, 5] at 5x.
 */
export function leveragePresets(maxLeverage: number, steps: readonly number[] = DEFAULT_LEVERAGE_PRESETS): number[] {
  if (!Number.isFinite(maxLeverage) || maxLeverage <= 0) return [];
  const below = [...new Set(steps)].filter(step => step > 0 && step < maxLeverage).sort((a, b) => a - b);
  return [...below, maxLeverage];
}
