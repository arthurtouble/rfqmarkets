// Advanced order types built from the venue's primitives, run by the client:
// - scale: one order split into several resting limit orders across a price range;
// - TWAP: one market order split into equal slices sent at a fixed interval;
// - trailing stop: an on-chain stop-loss that is moved after the price as it moves in the position's favour.
// The planners are pure and exported for previews; the runners place real orders through an RfqClient.

import type { RfqClient, Side } from "./client.js";

const MICRO = 1_000_000n;

/** "95000.25" -> 95_000_250_000n (USDC with six decimals). */
export function toMicro(value: string) {
  const match = /^(\d+)(?:\.(\d{1,6}))?$/.exec(value);
  if (!match) throw new Error(`invalid USDC amount: ${value}`);
  return BigInt(match[1]) * MICRO + BigInt((match[2] ?? "").padEnd(6, "0"));
}

/** 95_000_250_000n -> "95000.25". */
export function fromMicro(value: bigint) {
  if (value < 0n) throw new Error("negative USDC amount");
  const fraction = (value % MICRO).toString().padStart(6, "0").replace(/0+$/, "");
  return fraction ? `${value / MICRO}.${fraction}` : `${value / MICRO}`;
}

// ---- Scale orders ----

export interface ScalePlanInput {
  /** Total USDC notional across every order. */
  totalAmount: string;
  /** First and last limit price (either order); the orders are evenly spaced between them. */
  fromPrice: string;
  toPrice: string;
  /** Number of orders, 2 to 50. */
  count: number;
  /** Size of the last order relative to the first (1 = equal sizes, 3 = the last is three times the first). */
  skew?: number;
}

/** Evenly spaced prices with linearly weighted sizes; the sizes add up exactly to `totalAmount`. */
export function planScale(input: ScalePlanInput) {
  const { count } = input,
    skew = input.skew ?? 1;
  if (!Number.isInteger(count) || count < 2 || count > 50) throw new Error("count must be between 2 and 50");
  if (!(skew > 0 && skew <= 100)) throw new Error("skew must be above 0 and at most 100");
  const total = toMicro(input.totalAmount),
    from = toMicro(input.fromPrice),
    to = toMicro(input.toPrice);
  if (from === 0n || to === 0n) throw new Error("prices must be above zero");
  // Weights in parts per million so the split stays in integers.
  const weights = Array.from({ length: count }, (_, index) =>
      BigInt(Math.round((1 + ((skew - 1) * index) / (count - 1)) * 1_000_000)),
    ),
    weightSum = weights.reduce((sum, weight) => sum + weight, 0n),
    amounts = weights.map((weight) => (total * weight) / weightSum);
  amounts[count - 1] += total - amounts.reduce((sum, amount) => sum + amount, 0n);
  if (amounts.some((amount) => amount === 0n)) throw new Error("total is too small for that many orders");
  return amounts.map((amount, index) => ({
    amount: fromMicro(amount),
    limitPrice: fromMicro(from + ((to - from) * BigInt(index)) / BigInt(count - 1)),
  }));
}

/**
 * Places a scale order as resting limit orders, nearest-first as planned. If one is rejected the rest are
 * not placed; the orders already placed are returned with the error so the caller can keep or cancel them.
 */
export async function placeScaleOrder(
  client: RfqClient,
  input: ScalePlanInput & {
    market: string;
    side: Side;
    durationSeconds?: number;
    reduceOnly?: boolean;
    account?: string;
  },
) {
  const plan = planScale(input),
    placed: Array<{ amount: string; limitPrice: string; order: unknown }> = [];
  for (const level of plan) {
    try {
      const order = await client.limitOrder({
        market: input.market,
        side: input.side,
        amount: level.amount,
        limitPrice: level.limitPrice,
        ...(input.durationSeconds === undefined ? {} : { durationSeconds: input.durationSeconds }),
        ...(input.reduceOnly === undefined ? {} : { reduceOnly: input.reduceOnly }),
        ...(input.account === undefined ? {} : { account: input.account }),
      });
      placed.push({ ...level, order });
    } catch (error) {
      return { plan, placed, error };
    }
  }
  return { plan, placed };
}

// ---- TWAP ----

/** `slices` equal amounts (the remainder goes on the last) that add up exactly to `totalAmount`. */
export function planTwap(totalAmount: string, slices: number) {
  if (!Number.isInteger(slices) || slices < 2 || slices > 500)
    throw new Error("slices must be between 2 and 500");
  const total = toMicro(totalAmount),
    slice = total / BigInt(slices);
  if (slice === 0n) throw new Error("total is too small for that many slices");
  return Array.from({ length: slices }, (_, index) =>
    fromMicro(index === slices - 1 ? total - slice * BigInt(slices - 1) : slice),
  );
}

export interface TwapInput {
  market: string;
  side: Side;
  totalAmount: string;
  slices: number;
  /** Time between slices; the first slice is sent at once. */
  intervalMs: number;
  slippageBps?: number;
  reduceOnly?: boolean;
  account?: string;
  /** "stop" (default) ends the TWAP at the first failed slice; "skip" carries on with the next. */
  onError?: "stop" | "skip";
  signal?: AbortSignal;
  onSlice?: (event: { index: number; amount: string; result?: unknown; error?: unknown }) => void;
  /** Test hook; defaults to a timer that ends early when `signal` aborts. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

const abortableSleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });

/**
 * Sends a market order as `slices` market orders `intervalMs` apart. Runs until every slice is sent, a
 * slice fails (unless `onError` is "skip") or `signal` aborts; resolves with what was filled.
 */
export async function runTwap(client: RfqClient, input: TwapInput) {
  if (!(input.intervalMs >= 1_000)) throw new Error("intervalMs must be at least 1000");
  const amounts = planTwap(input.totalAmount, input.slices),
    sleep = input.sleep ?? abortableSleep,
    fills: Array<{ index: number; amount: string; result: unknown }> = [],
    failures: Array<{ index: number; amount: string; error: unknown }> = [];
  let filled = 0n,
    stopped: "complete" | "aborted" | "failed" = "complete";
  for (const [index, amount] of amounts.entries()) {
    if (input.signal?.aborted) {
      stopped = "aborted";
      break;
    }
    if (index > 0) {
      await sleep(input.intervalMs, input.signal);
      if (input.signal?.aborted) {
        stopped = "aborted";
        break;
      }
    }
    try {
      const result = await client.trade({
        market: input.market,
        side: input.side,
        amount,
        ...(input.slippageBps === undefined ? {} : { slippageBps: input.slippageBps }),
        ...(input.reduceOnly === undefined ? {} : { reduceOnly: input.reduceOnly }),
        ...(input.account === undefined ? {} : { account: input.account }),
      });
      filled += toMicro(amount);
      fills.push({ index, amount, result });
      input.onSlice?.({ index, amount, result });
    } catch (error) {
      failures.push({ index, amount, error });
      input.onSlice?.({ index, amount, error });
      if ((input.onError ?? "stop") === "stop") {
        stopped = "failed";
        break;
      }
    }
  }
  return { status: stopped, filledAmount: fromMicro(filled), fills, failures };
}

// ---- Trailing stop ----

/** The stop price `trailBps` behind the best price seen: below it for a long, above it for a short. */
export function trailingStopPrice(position: "long" | "short", extreme: bigint, trailBps: number) {
  if (!Number.isInteger(trailBps) || trailBps < 1 || trailBps >= 10_000)
    throw new Error("trailBps must be between 1 and 9999");
  const offset = (extreme * BigInt(trailBps)) / 10_000n;
  return position === "long" ? extreme - offset : extreme + offset;
}

/**
 * Pure state machine for a trailing stop: feed it mids (micro-USDC) and it says when the stop should move.
 * The stop only ever moves in the position's favour, and only by at least `stepBps` so it is not re-placed
 * on every tick.
 */
export class TrailingStop {
  private extreme: bigint | undefined;
  stop: bigint | undefined;

  constructor(
    readonly position: "long" | "short",
    readonly trailBps: number,
    readonly stepBps = 10,
  ) {
    trailingStopPrice(position, 1n, trailBps);
    if (!Number.isInteger(stepBps) || stepBps < 0) throw new Error("stepBps must be a whole number");
  }

  /** Returns the new stop price when it should move, otherwise undefined. */
  update(mid: bigint) {
    const better =
      this.extreme === undefined || (this.position === "long" ? mid > this.extreme : mid < this.extreme);
    if (!better) return undefined;
    this.extreme = mid;
    const next = trailingStopPrice(this.position, mid, this.trailBps);
    if (this.stop !== undefined) {
      const moved = this.position === "long" ? next - this.stop : this.stop - next;
      if (moved * 10_000n < this.stop * BigInt(this.stepBps) || moved <= 0n) return undefined;
    }
    this.stop = next;
    return next;
  }
}

export interface TrailingStopInput {
  market: string;
  /** Direction of the open position the stop protects. */
  position: "long" | "short";
  trailBps: number;
  /** Smallest move, in bps of the stop price, worth re-placing the order for (default 10). */
  stepBps?: number;
  slippageBps?: number;
  account?: string;
  signal?: AbortSignal;
  onMove?: (event: { stopPrice: string; orderId: string }) => void;
  onError?: (error: unknown) => void;
  /** Mid prices in micro-USDC; defaults to the client's market stream. Returns an unsubscribe function. */
  subscribe?: (onMid: (mid: bigint) => void) => () => void;
}

/**
 * Keeps an on-chain stop-loss for the whole position `trailBps` behind the best mid seen. Each move places
 * the new stop before cancelling the old one, so the position is never unprotected; both are reduce-only,
 * so even if both fire the second cannot open a new position. The last stop stays on chain after `signal`
 * aborts or this client goes away, so protection does not depend on the client staying connected.
 */
export function runTrailingStop(client: RfqClient, input: TrailingStopInput) {
  const state = new TrailingStop(input.position, input.trailBps, input.stepBps),
    subscribe =
      input.subscribe ??
      ((onMid: (mid: bigint) => void) =>
        client.streamMarkets(({ event, data }) => {
          const mid = (data as { markets?: Record<string, { mid?: string }> })?.markets?.[input.market]?.mid;
          if (event === "markets" && mid) onMid(BigInt(mid));
        }));
  let current: string | undefined,
    pending: bigint | undefined,
    busy: Promise<void> = Promise.resolve();
  const move = async () => {
    while (pending !== undefined && !input.signal?.aborted) {
      const stopPrice = fromMicro(pending);
      pending = undefined;
      try {
        const placed = (await client.triggerOrder({
          market: input.market,
          kind: "stop-loss",
          sizing: "position",
          triggerPrice: stopPrice,
          ...(input.slippageBps === undefined ? {} : { slippageBps: input.slippageBps }),
          ...(input.account === undefined ? {} : { account: input.account }),
        })) as { orderId: string };
        const previous = current;
        current = placed.orderId;
        input.onMove?.({ stopPrice, orderId: placed.orderId });
        if (previous) await client.cancelOrder(previous);
      } catch (error) {
        input.onError?.(error);
      }
    }
  };
  const unsubscribe = subscribe((mid) => {
    const next = state.update(mid);
    if (next === undefined) return;
    // Coalesce: only the latest stop matters if several moves arrive while one is being placed.
    pending = next;
    busy = busy.then(move);
  });
  input.signal?.addEventListener("abort", () => unsubscribe(), { once: true });
  return {
    stop: () => unsubscribe(),
    /** The order id of the stop currently on chain, if one has been placed. */
    orderId: () => current,
    settled: () => busy,
  };
}
