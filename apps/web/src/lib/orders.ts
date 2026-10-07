// Request bodies and checks for trigger orders (stop-loss, take-profit, stop
// entry), TP/SL pairs and closes. Pure, so the ticket can validate as the user
// types; the actions in data/actions.tsx send these bodies.
import { triggerAboveFor, triggerLimitPrice, triggerReached } from "../../../../packages/shared/src/trigger.js";
import { microToInput } from "./format.js";
import { DEFAULT_TRIGGER_SLIPPAGE_BPS, clampSlippageBps } from "./slippage.js";
import type { Market, RestingOrder, Side, TriggerKind } from "./types.js";

export { triggerAboveFor, triggerLimitPrice, triggerReached };

/** Order lifetimes the API accepts (`durationSeconds`). */
export const MIN_ORDER_DURATION_SECONDS = 300;
export const MAX_ORDER_DURATION_SECONDS = 2_592_000;
/** Limit orders stay good for 24 hours (as the existing ticket). */
export const LIMIT_ORDER_DURATION_SECONDS = 86_400;
/** Trigger orders and TP/SL default to the longest lifetime (30 days). */
export const TRIGGER_ORDER_DURATION_SECONDS = MAX_ORDER_DURATION_SECONDS;

export const clampDuration = (seconds: number | undefined, fallback: number) =>
  seconds === undefined || !Number.isFinite(seconds) ? fallback : Math.min(MAX_ORDER_DURATION_SECONDS, Math.max(MIN_ORDER_DURATION_SECONDS, Math.floor(seconds)));

type TriggerCommon = {
  market: Market;
  kind: TriggerKind;
  /** USDC 1e6 trigger price of the oracle mid. */
  triggerPriceMicro: bigint;
  /** Allowed fill past the trigger, 1..500 bps (default 100). */
  slippageBps?: number;
  durationSeconds?: number;
};
/**
 * `amount`: `amountMicro` USDC notional at the trigger price on `side`.
 * `position`: the whole current position, reduce-only (the side is derived).
 */
export type TriggerOrderInput = TriggerCommon & (
  | { sizing: "position"; side?: Side }
  | { sizing?: "amount"; side: Side; amountMicro: bigint; reduceOnly?: boolean }
);

/** Body for POST /v1/orders/trigger/prepare. Throws on input the API would reject. */
export function triggerPrepareBody(input: TriggerOrderInput, account: string, nonce: string) {
  if (input.triggerPriceMicro <= 0n) throw new Error("Enter a trigger price");
  const protective = input.kind !== "stop-entry";
  const common = {
    account, market: input.market, kind: input.kind, triggerPrice: microToInput(input.triggerPriceMicro),
    slippageBps: clampSlippageBps(input.slippageBps, DEFAULT_TRIGGER_SLIPPAGE_BPS),
    durationSeconds: clampDuration(input.durationSeconds, TRIGGER_ORDER_DURATION_SECONDS), nonce,
  };
  if (input.sizing === "position") return { ...common, sizing: "position" as const, ...(input.side ? { side: input.side } : {}), reduceOnly: true };
  if (input.amountMicro <= 0n) throw new Error("Enter an amount");
  if (protective && input.reduceOnly === false) throw new Error("Stop-loss and take-profit orders are reduce-only");
  return {
    ...common, sizing: "amount" as const, side: input.side, amount: microToInput(input.amountMicro),
    triggerAbove: triggerAboveFor(input.kind, input.side), reduceOnly: protective || (input.reduceOnly ?? false),
  };
}

export type TpslInput = {
  market: Market;
  /** USDC 1e6; at least one of the two. */
  takeProfitMicro?: bigint;
  stopLossMicro?: bigint;
  slippageBps?: number;
  durationSeconds?: number;
};

/** Body for POST /v1/orders/tpsl/prepare. Both legs close the whole position and share `nonce`. */
export function tpslPrepareBody(input: TpslInput, account: string, nonce: string) {
  if (input.takeProfitMicro === undefined && input.stopLossMicro === undefined) throw new Error("Set a take-profit or a stop-loss price");
  if ((input.takeProfitMicro ?? 1n) <= 0n || (input.stopLossMicro ?? 1n) <= 0n) throw new Error("Prices must be positive");
  return {
    account, market: input.market,
    ...(input.takeProfitMicro === undefined ? {} : { takeProfitPrice: microToInput(input.takeProfitMicro) }),
    ...(input.stopLossMicro === undefined ? {} : { stopLossPrice: microToInput(input.stopLossMicro) }),
    slippageBps: clampSlippageBps(input.slippageBps, DEFAULT_TRIGGER_SLIPPAGE_BPS),
    durationSeconds: clampDuration(input.durationSeconds, TRIGGER_ORDER_DURATION_SECONDS), nonce,
  };
}

/**
 * Why a TP/SL pair cannot be placed for a position of `size` (1e18, signed)
 * at the current `mid`, or null when it can: a long takes profit above and
 * stops out below the mid, a short the reverse. The API rejects a trigger
 * that is already reached.
 */
export function tpslProblem(size: bigint, midMicro: bigint, takeProfitMicro?: bigint, stopLossMicro?: bigint): string | null {
  if (size === 0n) return "No open position";
  if (takeProfitMicro === undefined && stopLossMicro === undefined) return "Set a take-profit or a stop-loss price";
  const long = size > 0n;
  if (takeProfitMicro !== undefined && (long ? takeProfitMicro <= midMicro : takeProfitMicro >= midMicro))
    return `Take-profit must be ${long ? "above" : "below"} the current price`;
  if (stopLossMicro !== undefined && (long ? stopLossMicro >= midMicro : stopLossMicro <= midMicro))
    return `Stop-loss must be ${long ? "below" : "above"} the current price`;
  return null;
}

/** Why a single trigger order would be rejected as already reached at `midMicro`, or null. */
export function triggerProblem(kind: TriggerKind, side: Side, triggerPriceMicro: bigint, midMicro: bigint): string | null {
  if (triggerPriceMicro <= 0n) return "Enter a trigger price";
  const above = triggerAboveFor(kind, side);
  return (above ? midMicro >= triggerPriceMicro : midMicro <= triggerPriceMicro)
    ? `Trigger must be ${above ? "above" : "below"} the current price`
    : null;
}

/**
 * Whether a session key may sign an order expiring at `deadlineMs`: the API
 * accepts a session signature only when the session outlives the intent's
 * deadline. Note that POST /v1/orders (resting limit and trigger orders)
 * currently verifies owner signatures only, so the actions sign orders with
 * the wallet; this check matters for immediate trades and closes.
 */
export const sessionCoversDeadline = (sessionValidUntilMs: number | null | undefined, deadlineMs: number) =>
  !!sessionValidUntilMs && deadlineMs <= sessionValidUntilMs;

/** Share of a position to close, in bps of its size: a percentage (0 < p <= 100) to 1..10_000. */
export function closeFractionBps(percent: number): number | null {
  if (!Number.isFinite(percent) || percent <= 0) return null;
  return Math.min(10_000, Math.max(1, Math.round(percent * 100)));
}

/** Trigger orders are those with a trigger type; older servers return no type (limit). */
export const isTriggerOrder = (order: RestingOrder) => !!order.type && order.type !== "limit";
/** The other open leg of a TP/SL pair, if any. */
export const pairedOrder = (order: RestingOrder, orders: readonly RestingOrder[]) =>
  order.pairId ? orders.find(other => other.pairId === order.pairId && other.orderId !== order.orderId && other.status === "open") ?? null : null;
/** Open TP/SL orders protecting `market`. */
export const protectiveOrders = (orders: readonly RestingOrder[], market: Market) =>
  orders.filter(order => order.market === market && order.status === "open" && (order.type === "stop-loss" || order.type === "take-profit"));
