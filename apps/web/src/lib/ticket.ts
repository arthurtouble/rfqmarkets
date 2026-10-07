// Order ticket math and checks. The trader types what they pay (margin, USDC)
// and picks a leverage; the position is pay × leverage. Paying at most the
// account's available margin keeps the trade inside initial margin, because
// the tiers never ask for more than notional / leverage while leverage is
// within what the tier allows.
import { MARGIN_TIERS } from "../../../../packages/shared/src/pricing.js";
import { maxLeverageAt, sizeFromLeverage } from "./leverage.js";
import type { Side } from "./types.js";

const CENT = 10_000n;
const BPS = 10_000n;

export const SIDE_WORD: Record<Side, string> = { buy: "Long", sell: "Short" };

/** Position notional (USDC 1e6) for `payMicro` at `leverage`. */
export const positionNotional = (payMicro: bigint, leverage: number) => sizeFromLeverage(payMicro, leverage);

/**
 * The highest leverage up to `marketMax` that the margin tiers allow for the
 * position `payMicro` would open at that leverage. Larger positions sit in
 * higher tiers, so this falls below the market max only for big sizes.
 */
export function leverageCeiling(payMicro: bigint, marketMax: number, scaleBps: number): number {
  if (!(marketMax > 0)) return 0;
  return Math.min(marketMax, maxLeverageAt(positionNotional(payMicro, marketMax), scaleBps));
}

/**
 * The largest position the margin tiers allow at `leverage`, or null when
 * every size does. Zero when even the first tier is below that leverage.
 */
export function maxNotionalAt(leverage: number, scaleBps: number): bigint | null {
  let largest = 0n;
  for (const tier of MARGIN_TIERS) {
    const tierMax = tier.maxNotional === undefined ? null : tier.maxNotional;
    if (maxLeverageAt(tierMax ?? 10n ** 30n, scaleBps) < leverage) return largest;
    if (tierMax === null) return null;
    largest = tierMax;
  }
  return largest;
}

/**
 * The most a trader can pay at `leverage`: available margin less the fee on
 * the position, no more than the per-trade cap allows, and small enough that
 * the margin tiers still allow that leverage. Rounded down to a cent. Zero
 * when nothing is available.
 */
export function maxPay({ availableMicro, leverage, feeBps, tradeCapMicro, scaleBps }: { availableMicro: bigint; leverage: number; feeBps: number; tradeCapMicro: bigint; scaleBps: number }): bigint {
  const hundredths = BigInt(Math.floor(leverage * 100 + 1e-9));
  if (availableMicro <= 0n || hundredths <= 0n) return 0n;
  // pay + pay × leverage × fee ≤ available
  let pay = availableMicro * 100n * BPS / (100n * BPS + hundredths * BigInt(feeBps));
  const tierMax = maxNotionalAt(leverage, scaleBps);
  for (const limit of [tradeCapMicro > 0n ? tradeCapMicro : null, tierMax]) {
    if (limit === null) continue;
    const byLimit = limit * 100n / hundredths;
    if (byLimit < pay) pay = byLimit;
  }
  return pay / CENT * CENT;
}

/** A share (1..100%) of `maxMicro`, rounded down to a cent. */
export const presetPay = (maxMicro: bigint, percent: number) => maxMicro * BigInt(percent) / 100n / CENT * CENT;

/** Leverage as the ticket shows it: "5×", "2.5×". */
export const leverageLabel = (leverage: number) => `${Number(leverage.toFixed(2))}×`;

export type TicketCheck = {
  side: Side;
  /** The price stream is live and the market's price is fresh. */
  priceLive: boolean;
  /** Governance has the market enabled (not paused). */
  enabled: boolean;
  /** The trade only shrinks the trader's position (reduce only, or opposite and no larger); allowed while a market is paused. */
  reduces: boolean;
  /** The venue accepts this direction now (false while hedging allows only exposure-reducing trades). */
  sideOpen: boolean;
  amountText: string;
  payMicro: bigint | null;
  notionalMicro: bigint;
  tradeCapMicro: bigint;
  leverage: number;
  /** Highest leverage the margin tiers allow at this size. */
  leverageCeiling: number;
  isLimit: boolean;
  limitMicro: bigint | null;
  /** Error from the local indicative quote, if any. */
  quoteError: string | null;
  hasQuote: boolean;
  /** Connected and the account cannot carry the margin this trade adds. */
  marginShort: boolean;
};

export const MARGIN_PROBLEM = "Add funds for this size";

/** Why the ticket cannot submit, in the words the button shows, or null when it can. */
export function ticketProblem(check: TicketCheck): string | null {
  if (!check.enabled && !check.reduces) return "Paused · closing only";
  if (!check.sideOpen) return `${SIDE_WORD[check.side]} is closed right now`;
  if (!check.priceLive) return "Waiting for a fresh price";
  if (!check.amountText) return "Enter an amount";
  if (check.payMicro === null) return "Enter a valid amount";
  if (check.tradeCapMicro > 0n && check.notionalMicro > check.tradeCapMicro) return "Over the per-trade limit";
  if (check.leverage > check.leverageCeiling) return `Up to ${leverageLabel(check.leverageCeiling)} at this size`;
  if (check.isLimit && check.limitMicro === null) return "Enter a limit price";
  if (check.quoteError) return check.quoteError;
  if (!check.hasQuote) return "Waiting for a fresh price";
  if (check.marginShort) return MARGIN_PROBLEM;
  return null;
}

/** The submit button's label, e.g. "Long BTC · $250.00 at 5×". */
export function submitLabel({ side, market, pay, leverage, isLimit }: { side: Side; market: string; pay: string; leverage: number; isLimit: boolean }) {
  return `${isLimit ? `Limit ${SIDE_WORD[side].toLowerCase()}` : SIDE_WORD[side]} ${market} · ${pay} at ${leverageLabel(leverage)}`;
}

/** Whether trading `signedNotional` (positive long) at most closes `positionSize` (signed base) worth `positionNotional`. */
export function reducesPosition(positionSize: bigint, positionNotionalMicro: bigint, signedNotional: bigint) {
  if (positionSize === 0n || signedNotional === 0n || (positionSize > 0n) === (signedNotional > 0n)) return false;
  return (signedNotional < 0n ? -signedNotional : signedNotional) <= positionNotionalMicro;
}

/** Whether a limit price would fill right away against the expected price. */
export const limitMarketable = (side: Side, expectedMicro: bigint, limitMicro: bigint) =>
  side === "buy" ? expectedMicro <= limitMicro : expectedMicro >= limitMicro;

/** Firm quotes count as expired this long before their deadline, leaving time to sign and submit. */
export const QUOTE_EXPIRY_MARGIN_MS = 1_500;

/** Whole seconds left on a firm quote (0 once it is too close to its deadline to sign). */
export const quoteSecondsLeft = (expiresAtMs: number, nowMs: number) =>
  Math.max(0, Math.floor((expiresAtMs - QUOTE_EXPIRY_MARGIN_MS - nowMs) / 1_000));

export const quoteUsable = (expiresAtMs: number, nowMs: number) => nowMs < expiresAtMs - QUOTE_EXPIRY_MARGIN_MS;

/** What the ticket remembers per market between visits. */
export type TicketMemory = { pay: string; leverage: number };

const DECIMAL_DRAFT = /^\d*\.?\d*$/;
/** Whether `text` is a partial decimal a person might be typing ("", "1.", ".5"). */
export const isDecimalDraft = (text: string) => DECIMAL_DRAFT.test(text);

/** Reads remembered ticket inputs; anything malformed is dropped. */
export function parseTicketMemory(raw: string | null): Partial<TicketMemory> {
  if (!raw) return {};
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    const memory: Partial<TicketMemory> = {};
    if (typeof value.pay === "string" && isDecimalDraft(value.pay) && value.pay.length <= 20) memory.pay = value.pay;
    if (typeof value.leverage === "number" && Number.isFinite(value.leverage) && value.leverage > 0) memory.leverage = value.leverage;
    return memory;
  } catch {
    return {};
  }
}
