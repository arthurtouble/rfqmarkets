// What a bet's share card says: the headline number, the caption that goes
// with the image, and where the tick line sits on the card. Drawing lives in
// updown/ShareCard.tsx; this file stays pure so it can be tested.
import type { ChartPoint } from "./candles.js";
import { signedUsdc, usdc } from "./format.js";
import type { Market } from "./types.js";

export type ShareBet = {
  market: Market;
  /** Display name, such as "Bitcoin". */
  name: string;
  long: boolean;
  /** The multiplier the bet was placed at, when this browser placed it. */
  multiplier: number | null;
  /** Result so far (open) or at cash out (closed), USDC 1e6. */
  pnl: bigint;
  /** `pnl` as a fraction of the stake, or null without one. */
  ret: number | null;
  entryPrice: bigint;
  /** The live price for an open bet, the cash-out price for a closed one. */
  price: bigint;
  closed: boolean;
};

/** "+49.6%" (one decimal under 1000%, none above), or null without a return. */
export function returnLabel(ret: number | null): string | null {
  if (ret === null || !Number.isFinite(ret)) return null;
  const pct = ret * 100;
  const digits = Math.abs(pct) >= 1000 ? 0 : 1;
  const text = Math.abs(pct).toFixed(digits);
  if (Number(text) === 0) return `${(0).toFixed(digits)}%`;
  return `${pct > 0 ? "+" : "-"}${text}%`;
}

/** "Up 3×" or "Down" when the multiplier is unknown. */
export const betLabel = (bet: Pick<ShareBet, "long" | "multiplier">) =>
  `${bet.long ? "Up" : "Down"}${bet.multiplier ? ` ${bet.multiplier}×` : ""}`;

/** The big number on the card: the return when known, else the dollar result. */
export const shareHeadline = (bet: ShareBet) => returnLabel(bet.ret) ?? signedUsdc(bet.pnl);

/** The line under it: the dollar result when the headline is the return, else nothing. */
export const shareSubline = (bet: ShareBet) => (returnLabel(bet.ret) ? signedUsdc(bet.pnl) : null);

/** "Entry $2,500.00 → $2,550.00" for the card's footer row. */
export const sharePrices = (bet: ShareBet) => `Entry ${usdc(bet.entryPrice)} → ${usdc(bet.price)}`;

/** The text posted with the image. */
export function shareCaption(bet: ShareBet): string {
  const result = [signedUsdc(bet.pnl), returnLabel(bet.ret)].filter(Boolean);
  const amount = result.length === 2 ? `${result[0]} (${result[1]})` : result[0];
  const call = `${betLabel(bet)} on ${bet.name}`;
  return bet.closed ? `Cashed out ${amount} going ${call}.` : `${call}: ${amount} so far.`;
}

/** "rfq-btc-up.png" */
export const shareFileName = (bet: Pick<ShareBet, "market" | "long">) =>
  `rfq-${bet.market.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${bet.long ? "up" : "down"}.png`;

/**
 * Places the tick line in a `width` × `height` box: time runs left to right
 * across the points' span and the price fills the box with `pad` of headroom
 * (a fraction of the range) above and below, so a flat line sits in the middle.
 * `extra` prices (the entry) are kept inside the box too.
 */
export function placeLine(
  points: readonly ChartPoint[],
  width: number,
  height: number,
  extra: readonly number[] = [],
  pad = 0.12,
): { xy: Array<[number, number]>; y: (value: number) => number } {
  const values = [...points.map((point) => point.value), ...extra];
  let low = Math.min(...values),
    high = Math.max(...values);
  if (!values.length) ((low = 0), (high = 1));
  if (high === low) ((low -= Math.abs(low) * 0.001 || 1), (high += Math.abs(high) * 0.001 || 1));
  const span = high - low;
  low -= span * pad;
  high += span * pad;
  const y = (value: number) => height - ((value - low) / (high - low)) * height;
  const first = points[0]?.time ?? 0,
    last = points.at(-1)?.time ?? 0;
  const x = (time: number) => (last === first ? width / 2 : ((time - first) / (last - first)) * width);
  return { xy: points.map((point) => [x(point.time), y(point.value)]), y };
}
