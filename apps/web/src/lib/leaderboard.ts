// Leaderboard and points helpers. The indexer ranks owners (isolated Home bets count towards their
// wallet) and awards one point per 100 USDC traded, counted per UTC week starting Thursday 00:00.
import type { LeaderboardEntry, LeaderboardSort, LeaderboardWindow, Points } from "./types.js";

export const WINDOWS: ReadonlyArray<{ id: LeaderboardWindow; label: string }> = [
  { id: "1d", label: "24H" },
  { id: "7d", label: "7D" },
  { id: "30d", label: "30D" },
  { id: "all", label: "All" },
];
export const SORTS: ReadonlyArray<{ id: LeaderboardSort; label: string }> = [
  { id: "volume", label: "Volume" },
  { id: "pnl", label: "PnL" },
];

const WEEK_MS = 7 * 86_400_000;

/** Start of the points week containing `nowMs` (weeks align to the Unix epoch, a Thursday). */
export const weekStart = (nowMs: number) => Math.floor(nowMs / WEEK_MS) * WEEK_MS;
/** When the current points week ends. */
export const weekEnd = (nowMs: number) => weekStart(nowMs) + WEEK_MS;

/** Points earned in the week containing `nowMs`, and in total. */
export function pointsSummary(points: Points | undefined, nowMs: number) {
  const start = weekStart(nowMs);
  const week = points?.weeks.find((item) => item.weekStartMs === start);
  return { thisWeek: BigInt(week?.points ?? "0"), total: BigInt(points?.total ?? "0") };
}

/** The connected trader's row, if they made the board. Addresses compare case-insensitively. */
export const findTrader = (traders: readonly LeaderboardEntry[], address: string | null | undefined) =>
  address ? traders.find((item) => item.account.toLowerCase() === address.toLowerCase()) : undefined;

/** "12,345" with grouping; points are whole numbers. */
export const pointsLabel = (value: bigint | string) => BigInt(value).toLocaleString("en-US");

/** "3d 4h" or "5h 12m" until `endMs`. */
export function countdown(endMs: number, nowMs: number) {
  const minutes = Math.max(0, Math.floor((endMs - nowMs) / 60_000));
  const days = Math.floor(minutes / 1_440),
    hours = Math.floor((minutes % 1_440) / 60);
  return days > 0 ? `${days}d ${hours}h` : `${hours}h ${minutes % 60}m`;
}
