// The Up / Down screen's sizing and its live tick line. A bet is a market
// order: the stake is the margin, the multiplier is the leverage, and the bet
// stays open until the player cashes out (or is liquidated), like any perp.
import type { ChartPoint } from "./candles.js";
import { positionNotional } from "./ticket.js";

/** Stake presets in whole dollars. */
export const STAKE_PRESETS = [10, 25, 50, 100] as const;
/** Multiplier presets; the market's own maximum caps them. */
export const MULTIPLIER_PRESETS = [2, 3, 5, 10] as const;
export const DEFAULT_STAKE = 25;
export const DEFAULT_MULTIPLIER = 3;
/** How far back the tick line reaches. */
export const TICK_WINDOW_MS = 5 * 60_000;
/** Most points the tick line keeps; older ones drop first. */
export const MAX_TICKS = 600;

/** The multipliers this market allows: the presets up to `maxLeverage`, or the maximum alone below 2×. */
export function multiplierChoices(maxLeverage: number): number[] {
  const allowed = MULTIPLIER_PRESETS.filter((step) => step <= maxLeverage);
  return allowed.length ? allowed : [Math.max(1, Math.floor(maxLeverage))];
}

/** The multiplier to show: the chosen one when the market allows it, else the closest allowed one below it. */
export function pickMultiplier(chosen: number, choices: readonly number[]): number {
  const fitting = choices.filter((step) => step <= chosen);
  return fitting.length ? fitting[fitting.length - 1] : choices[0];
}

/** Position size (USDC 1e6) for a stake (USDC 1e6) at a multiplier. */
export const betNotional = (stakeMicro: bigint, multiplier: number) =>
  positionNotional(stakeMicro, multiplier);

/** What a 1% move the player's way is worth on a position of `notionalMicro`, before costs. */
export const onePercentGain = (notionalMicro: bigint) => notionalMicro / 100n;

/**
 * Adds a live mid to the tick line. A tick at or before the last point's time
 * replaces nothing (the stream can repeat a snapshot); points older than the
 * window, or beyond `MAX_TICKS`, drop off the front.
 */
export function appendTick(
  points: readonly ChartPoint[],
  tick: ChartPoint,
  windowMs = TICK_WINDOW_MS,
  max = MAX_TICKS,
): ChartPoint[] {
  const last = points.at(-1);
  if (last && tick.time <= last.time) return points as ChartPoint[];
  const from = tick.time - windowMs;
  const kept = points.filter((point) => point.time >= from);
  kept.push(tick);
  return kept.length > max ? kept.slice(kept.length - max) : kept;
}
