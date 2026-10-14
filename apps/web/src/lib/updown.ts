// The Up / Down screen's sizing, wording and live tick line. A trade there is
// a market order: the amount is the margin, the multiplier is the leverage, and
// it stays open until the trader cashes out (or it auto-closes), like any perp.
import type { ChartPoint } from "./candles.js";
import { usdcCompact } from "./format.js";
import { MARGIN_PROBLEM, leverageLabel, positionNotional } from "./ticket.js";
import type { Side } from "./types.js";

/** The words Home uses for the two sides. */
export const UP_DOWN: Record<Side, string> = { buy: "Up", sell: "Down" };

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

/** What Home remembers about the trade it opened in a market, so the return reads against the amount put in. */
export type BetRecord = { stake: bigint; multiplier: number; notional: bigint };

export const betRecordText = (record: BetRecord) =>
  JSON.stringify({
    stake: record.stake.toString(),
    multiplier: record.multiplier,
    notional: record.notional.toString(),
  });

/** A stored record, or null when it is missing, malformed or from an older version without a size. */
export function parseBetRecord(raw: string | null): BetRecord | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as { stake?: unknown; multiplier?: unknown; notional?: unknown };
    if (typeof value.stake !== "string" || typeof value.notional !== "string") return null;
    if (!/^\d{1,20}$/.test(value.stake) || !/^\d{1,24}$/.test(value.notional)) return null;
    const multiplier = Number(value.multiplier);
    if (!Number.isFinite(multiplier) || multiplier <= 0) return null;
    const stake = BigInt(value.stake),
      notional = BigInt(value.notional);
    return stake > 0n && notional > 0n ? { stake, multiplier, notional } : null;
  } catch {
    return null;
  }
}

/**
 * Whether `record` describes an open position whose size at entry was
 * `entryNotional` (USDC 1e6): within 10%, which allows for the fill price. A
 * position opened elsewhere, or grown since, does not match.
 */
export const recordMatches = (record: BetRecord, entryNotional: bigint) => {
  const gap =
    record.notional > entryNotional ? record.notional - entryNotional : entryNotional - record.notional;
  return gap * 10n <= record.notional;
};

/**
 * The ticket's reason a trade can't go yet, in Home's words: Up and Down
 * rather than Long and Short, and limits as money.
 */
export function homeProblem(
  problem: string | null,
  side: Side,
  { multiplier, tradeCapMicro }: { multiplier: number; tradeCapMicro: bigint },
): string | null {
  if (problem === null || problem === MARGIN_PROBLEM) return problem;
  const word = UP_DOWN[side];
  if (problem.startsWith("Paused")) return "This market is paused for now";
  if (/is closed right now$/.test(problem) || problem.startsWith("Only exposure-reducing"))
    return `${word} is paused for now`;
  if (problem.startsWith("Waiting for")) return "Prices are catching up";
  if (problem === "Over the per-trade limit" || problem.startsWith("Max per trade")) {
    const hundredths = BigInt(Math.round(multiplier * 100));
    return tradeCapMicro > 0n && hundredths > 0n
      ? `Max at ${leverageLabel(multiplier)} is ${usdcCompact((tradeCapMicro * 100n) / hundredths)}`
      : "That's more than one trade allows";
  }
  if (problem.endsWith("at this size")) return problem.replace("at this size", "at this amount");
  return problem;
}

/**
 * What a position of `notional` loses if the price goes from `entry` to `exit`. The whole balance backs a
 * trade, so at the auto-close price this can be more than the amount put in.
 */
export const lossAt = (notional: bigint, entry: bigint, exit: bigint) =>
  entry > 0n ? (notional * (entry > exit ? entry - exit : exit - entry)) / entry : 0n;
