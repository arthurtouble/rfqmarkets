// Leaderboard and points from replayed portfolios. Everything here is derived from indexed clearing events,
// so any client can recompute it. Isolated accounts count towards their owner.
// Amounts are USDC micro-units.

import type { PortfolioReplay } from "./portfolio.js";

const DAY_MS = 86_400_000;
export const LEADERBOARD_WINDOWS = {
  "1d": DAY_MS,
  "7d": 7 * DAY_MS,
  "30d": 30 * DAY_MS,
  all: Infinity,
} as const;
export type LeaderboardWindow = keyof typeof LEADERBOARD_WINDOWS;
export type LeaderboardSort = "volume" | "pnl";

/** One point per 100 USDC of trade notional. */
export const USDC_PER_POINT = 100_000_000n;
/** Points are reported per week (UTC, starting Thursday 00:00 like the Unix epoch). */
export const POINTS_WEEK_MS = 7 * DAY_MS;

export interface WindowStats {
  volume: bigint;
  /** realizedPnl - fees + funding - liquidationPenalties earned inside the window. */
  netPnl: bigint;
  tradeCount: number;
}

/** Trade volume, trade count and net PnL earned at or after `sinceMs`. */
export function windowStats(replay: PortfolioReplay, sinceMs: number): WindowStats {
  let volume = 0n,
    tradeCount = 0;
  for (const fill of replay.fills)
    if (fill.kind === "trade" && fill.timeMs >= sinceMs) {
      volume += BigInt(fill.notional);
      tradeCount++;
    }
  // Net PnL is cumulative on the points, so the window's PnL is the last value minus the value before it.
  let before = 0n;
  for (const point of replay.points) {
    if (point.timeMs >= sinceMs) break;
    before = BigInt(point.netPnl);
  }
  const last = replay.points.at(-1);
  return { volume, tradeCount, netPnl: (last ? BigInt(last.netPnl) : 0n) - before };
}

/** Adds isolated accounts' stats into their owners'. */
export function mergeByOwner(
  stats: ReadonlyMap<string, WindowStats>,
  ownerOf: (account: string) => string | undefined,
) {
  const merged = new Map<string, WindowStats & { accounts: string[] }>();
  for (const [account, value] of stats) {
    const owner = ownerOf(account) ?? account,
      entry = merged.get(owner) ?? { volume: 0n, netPnl: 0n, tradeCount: 0, accounts: [] };
    entry.volume += value.volume;
    entry.netPnl += value.netPnl;
    entry.tradeCount += value.tradeCount;
    entry.accounts.push(account);
    merged.set(owner, entry);
  }
  return merged;
}

/** Highest first; ties go to the lower address so the order is stable. */
export function rankTraders(
  stats: ReadonlyMap<string, WindowStats & { accounts: string[] }>,
  sort: LeaderboardSort,
  limit: number,
) {
  return [...stats]
    .filter(([, value]) => value.tradeCount > 0)
    .sort(([leftAccount, left], [rightAccount, right]) => {
      const a = sort === "volume" ? left.volume : left.netPnl,
        b = sort === "volume" ? right.volume : right.netPnl;
      return a === b ? (leftAccount.toLowerCase() < rightAccount.toLowerCase() ? -1 : 1) : a > b ? -1 : 1;
    })
    .slice(0, limit)
    .map(([account, value], index) => ({
      rank: index + 1,
      account,
      volume: value.volume.toString(),
      netPnl: value.netPnl.toString(),
      tradeCount: value.tradeCount,
      points: (value.volume / USDC_PER_POINT).toString(),
    }));
}

/** Points per week from trade fills (any number of replays, e.g. an owner and its isolated accounts). */
export function weeklyPoints(replays: readonly PortfolioReplay[]) {
  const volumeByWeek = new Map<number, bigint>();
  for (const replay of replays)
    for (const fill of replay.fills) {
      if (fill.kind !== "trade") continue;
      const week = Math.floor(fill.timeMs / POINTS_WEEK_MS) * POINTS_WEEK_MS;
      volumeByWeek.set(week, (volumeByWeek.get(week) ?? 0n) + BigInt(fill.notional));
    }
  const weeks = [...volumeByWeek]
    .sort(([left], [right]) => left - right)
    .map(([weekStartMs, volume]) => ({
      weekStartMs,
      volume: volume.toString(),
      points: (volume / USDC_PER_POINT).toString(),
    }));
  return {
    total: weeks.reduce((sum, week) => sum + BigInt(week.points), 0n).toString(),
    weeks,
  };
}
