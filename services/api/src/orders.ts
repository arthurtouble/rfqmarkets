import { getAddress, parseUnits } from "ethers";
import type { FastifyInstance, FastifyReply } from "fastify";
import {
  cancelToWire,
  cancelTypes,
  intentDigest,
  intentToWire,
  intentTypes,
  triggerToWire,
  triggeredIntentToWire,
  triggeredIntentTypes,
  type CancelIntent,
  type TradeIntent,
  type Trigger,
} from "../../../packages/shared/src/eip712.js";
import { BASE, ceilDiv, formatUsdc, parseUsdc } from "../../../packages/shared/src/policy.js";
import {
  triggerAboveFor,
  triggerLimitPrice,
  triggerReached,
  triggeredFillDelta,
  type TriggerKind,
} from "../../../packages/shared/src/trigger.js";
import { ExpiryIndex } from "./bounded-state.js";
import type { ChainReader } from "./chain.js";
import type { ApiContext } from "./context.js";
import { INSUFFICIENT_MARGIN, type ExecutionService } from "./execution.js";
import type { HttpGuards } from "./http.js";
import { LimitTriggerBook, StopTriggerBook } from "./limit-book.js";
import { abs, marketIndex, marketSymbols, type Market, type Side } from "./markets.js";
import type { IsolatedOwnerReader } from "../../../packages/shared/src/isolated.js";
import { signingAccount, validOwnerSignature } from "./owner-signature.js";
import { publicError } from "./public-error.js";
import type { QuoteEngine } from "./quoting.js";
import {
  cancelExecuteSchema,
  orderPlaceSchema,
  orderPrepareSchema,
  tpslPrepareSchema,
  triggerOrderPrepareSchema,
} from "./schemas.js";
import { admitSponsoredAction, verifySignedAction } from "./signed-actions.js";

type OrderStatus = "prepared" | "open" | "executing" | "filled" | "cancelled" | "expired";
export type OrderType = "limit" | TriggerKind;
/** A triggered order's signed trigger plus how it was built; stored as `resting_orders.trigger_json`. */
type TriggerTerms = Trigger & {
  slippageBps: number;
  sizing: "amount" | "position";
  /** Shared by the take-profit and stop-loss legs of one TP/SL pair (they share a nonce). */
  pairId?: string;
};
type RestingOrder = {
  orderId: string;
  type: OrderType;
  intent: TradeIntent;
  /** Present on trigger orders only. */
  trigger?: TriggerTerms;
  market: Market;
  side: Side;
  amount: string;
  userSignature?: string;
  status: OrderStatus;
  createdAtMs: number;
  updatedAtMs: number;
  transactionHash?: string;
  lastError?: string;
  /** Consecutive non-transient execution refusals since the order last filled (in memory only). */
  refusals?: number;
};

/** Unsigned prepared orders are dropped after five minutes. */
const PREPARED_ORDER_TTL_MS = 300_000;
/** Limit and trigger orders cap their fee at 2 bps of the notional at the protected price. */
const ORDER_FEE_BPS = 2n;
const MAX_TRIGGERS_PER_MARKET = 16;
const ORDER_CHECK_DELAY_MS = 25;
const ORDER_RECONCILE_MS = 30_000;
const CANCEL_TTL_SECONDS = 120;
/** Position reads per reduce-only sweep; the rest wait for the next sweep. */
const MAX_POSITION_SWEEP = 256;
/** Live orders one account may hold unless `maxRestingOrdersPerAccount` says otherwise. */
const DEFAULT_MAX_ORDERS_PER_ACCOUNT = 50;
/** Unsigned prepared orders held at once, at most, unless `maxPreparedOrders` says otherwise. */
const DEFAULT_MAX_PREPARED_ORDERS = 10_000;
/**
 * An order whose execution is refused this many times in a row for a non-transient reason (a bad
 * signature or a failed settlement simulation) is cancelled off chain: each attempt reserves risk.
 */
export const MAX_CONSECUTIVE_REFUSALS = 5;
const MARGIN_CANCEL_NOTE =
  "cancelled: the account cannot cover this order's margin; the signed order stays valid on chain until its deadline or a nonce cancel";
const REFUSED_CANCEL_NOTE =
  "cancelled after repeated execution refusals; the signed order stays valid on chain until its deadline or a nonce cancel";
/**
 * The leader stops acting on a reduce-only trigger once its position closes. The signed intent stays
 * executable on chain until its deadline or a nonce cancel, so only this leader's choice retires it.
 */
const POSITION_CLOSED_NOTE = "position closed";
/** Shown on a crossed trigger whose fill would break its signed limit, e.g. after a price gap. */
const PAST_LIMIT_NOTE = "triggered; waiting for the price to come back within the slippage limit";
const TRIGGER_WORDS: Record<TriggerKind, string> = {
  "stop-loss": "stop-loss",
  "take-profit": "take-profit",
  "stop-entry": "stop entry",
};

const isLive = (order: RestingOrder) =>
  order.status === "prepared" || order.status === "open" || order.status === "executing";
/** Signed and not yet final: counts toward resting-order capacity. Prepared orders have their own cap. */
const isResting = (order: RestingOrder) => order.status === "open" || order.status === "executing";
const marketable = (order: RestingOrder, price: bigint) =>
  order.side === "buy" ? price <= order.intent.limitPrice : price >= order.intent.limitPrice;
/** A reduce-only order can still reduce: the position is open and on the other side of the order. */
const reducible = (positionSize: bigint, baseDelta: bigint) =>
  positionSize !== 0n && positionSize > 0n !== baseDelta > 0n;
const positionKey = (account: string, market: Market) => `${account}:${market}`;

function intentFromJson(wire: Record<string, string | number | boolean>): TradeIntent {
  return {
    account: getAddress(String(wire.account)),
    market: Number(wire.market),
    baseDelta: BigInt(wire.baseDelta),
    limitPrice: BigInt(wire.limitPrice),
    maxFee: BigInt(wire.maxFee),
    nonce: BigInt(wire.nonce),
    deadline: BigInt(wire.deadline),
    reduceOnly: Boolean(wire.reduceOnly),
  };
}

function triggerTermsToJson(terms: TriggerTerms) {
  return JSON.stringify({ ...terms, triggerPrice: terms.triggerPrice.toString() });
}

function triggerTermsFromJson(json: string): TriggerTerms {
  const value = JSON.parse(json);
  return {
    triggerPrice: BigInt(value.triggerPrice),
    triggerAbove: Boolean(value.triggerAbove),
    slippageBps: Number(value.slippageBps),
    sizing: value.sizing === "position" ? "position" : "amount",
    pairId: value.pairId ? String(value.pairId) : undefined,
  };
}

type ExecutionBody = {
  transaction?: { hash: string };
  error?: string;
  details?: unknown;
  code?: string;
  retriable?: boolean;
};

/**
 * How a failed resting-order execution counts toward cancelling it. `margin`: the account cannot
 * cover the trade, cancel now. `refused`: a non-transient refusal (bad signature, failed settlement
 * simulation) that would recur and re-reserve risk on every tick. Everything else (price moved,
 * capacity, outages, retriable failures) is `transient` and never cancels an order. A protective
 * reduce-only order is never cancelled at once for margin; it only counts as a refusal.
 */
export function executionRefusal(status: number, body: ExecutionBody, reduceOnly = false) {
  if (body.code === INSUFFICIENT_MARGIN) return reduceOnly ? ("refused" as const) : ("margin" as const);
  if (body.retriable) return "transient" as const;
  if (status === 401 || (status === 409 && body.error === "settlement simulation failed"))
    return "refused" as const;
  return "transient" as const;
}

/** A client error the prepare routes answer with its own status. */
class OrderRejection extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Answer a prepare route: our own rejections keep their status and message, anything else is screened. */
function rejectOrder(reply: FastifyReply, error: unknown, fallback: string) {
  if (error instanceof OrderRejection) return reply.code(error.status).send({ error: error.message });
  return reply.code(409).send({ error: publicError(error, fallback) });
}

/**
 * Resting all-or-none limit orders and triggered orders (stop-loss, take-profit, stop entry). Each is
 * a signed intent held off chain and executed through the market-order path: a limit order once a
 * firm quote crosses its limit price, a triggered order once the oracle mid crosses its trigger and a
 * firm quote respects its slippage-adjusted limit (settled with `executeTriggeredTrade`).
 */
export class LimitOrders {
  private readonly orders = new Map<string, RestingOrder>();
  private readonly triggers = new LimitTriggerBook();
  private readonly stops = new StopTriggerBook();
  private readonly preparedExpiries = new ExpiryIndex();
  /** (account, market) pairs whose reduce-only trigger orders need a position re-check. */
  private readonly positionSweeps = new Set<string>();
  private readonly capacity: number;
  private readonly perAccount: number;
  private readonly preparedCapacity: number;
  private checking = false;
  private checkQueued = false;
  private checkTimer: ReturnType<typeof setTimeout> | undefined;
  private reconcileTimer: ReturnType<typeof setInterval> | undefined;

  constructor(
    private readonly ctx: ApiContext,
    private readonly chain: ChainReader,
    private readonly quoting: QuoteEngine,
    private readonly execution: ExecutionService,
  ) {
    this.capacity = ctx.options.maxRestingOrders ?? 100_000;
    this.perAccount = ctx.options.maxRestingOrdersPerAccount ?? DEFAULT_MAX_ORDERS_PER_ACCOUNT;
    this.preparedCapacity =
      ctx.options.maxPreparedOrders ?? Math.min(this.capacity, DEFAULT_MAX_PREPARED_ORDERS);
    this.restore();
    ctx.onPrune((now) => {
      for (const id of this.preparedExpiries.takeExpired(now))
        if (this.orders.get(id)?.status === "prepared") this.orders.delete(id);
    });
    ctx.onPositionChange((account, market) => {
      this.positionSweeps.add(positionKey(account, market));
      this.scheduleCheck();
    });
  }

  get stats() {
    let active = 0,
      prepared = 0;
    for (const order of this.orders.values())
      if (isResting(order)) active++;
      else if (order.status === "prepared") prepared++;
    return {
      active,
      prepared,
      indexed: this.triggers.size,
      triggersIndexed: this.stops.size,
      capacity: this.capacity,
      preparedCapacity: this.preparedCapacity,
    };
  }

  /** Signed live orders held by one account. */
  private restingFor(account: string) {
    let count = 0;
    for (const order of this.orders.values())
      if (isResting(order) && order.intent.account === account) count++;
    return count;
  }

  /**
   * Bounds for staging `count` prepared orders: global resting capacity, the prepared cap and the
   * account's live-order cap. Prepared orders never consume resting capacity, so unsigned spam
   * cannot crowd out signed orders.
   */
  private assertCanPrepare(account: string, count = 1) {
    this.ctx.prune();
    const { active, prepared } = this.stats;
    if (active + count > this.capacity || prepared + count > this.preparedCapacity)
      throw new OrderRejection(409, "order capacity reached");
    if (this.restingFor(account) + count > this.perAccount)
      throw new OrderRejection(409, "account open order limit reached");
  }

  /** Signed capacity at placement: global and per-account live orders. */
  private placementRefusal(order: RestingOrder) {
    if (this.stats.active >= this.capacity) return "order capacity reached";
    if (this.restingFor(order.intent.account) >= this.perAccount) return "account open order limit reached";
    return undefined;
  }

  /** Opening orders need collateral at placement; reduce-only orders protect an existing position. */
  private async assertFunded(order: RestingOrder) {
    const { clearing } = this.ctx;
    if (!clearing || order.intent.reduceOnly) return;
    let collateral: bigint;
    try {
      collateral = BigInt(await clearing.collateralOf(order.intent.account));
    } catch {
      throw new OrderRejection(503, "chain unavailable");
    }
    if (collateral <= 0n) throw new OrderRejection(409, "deposit collateral before placing orders");
  }

  private restore() {
    const rows =
      this.ctx.journal?.prepare("SELECT * FROM resting_orders WHERE status IN ('open','executing')").all() ??
      [];
    for (const row of rows) {
      const item = row as Record<string, string | number | null>;
      const order: RestingOrder = {
        orderId: String(item.order_id),
        type: (item.order_type ?? "limit") as OrderType,
        intent: intentFromJson(JSON.parse(String(item.intent_json))),
        trigger: item.trigger_json ? triggerTermsFromJson(String(item.trigger_json)) : undefined,
        market: item.market as Market,
        side: item.side as Side,
        amount: String(item.amount),
        userSignature: String(item.user_signature),
        // Orders interrupted mid-execution reopen; a consumed nonce closes them before any retry.
        status: "open",
        createdAtMs: Number(item.created_ms),
        updatedAtMs: Number(item.updated_ms),
        transactionHash: item.tx_hash ? String(item.tx_hash) : undefined,
        lastError: item.last_error ? String(item.last_error) : undefined,
      };
      if (order.type !== "limit" && !order.trigger) continue;
      this.orders.set(order.orderId, order);
      this.arm(order);
      if (order.intent.reduceOnly && order.trigger)
        this.positionSweeps.add(positionKey(order.intent.account, order.market));
    }
  }

  /** (Re-)index an open order in its book: limit orders by limit price, triggers by trigger price. */
  private arm(order: RestingOrder) {
    const deadlineMs = Number(order.intent.deadline) * 1_000;
    if (order.trigger)
      this.stops.add(
        order.orderId,
        order.market,
        order.trigger.triggerAbove,
        order.trigger.triggerPrice,
        deadlineMs,
      );
    else this.triggers.add(order.orderId, order.market, order.side, order.intent.limitPrice, deadlineMs);
  }

  private disarm(order: RestingOrder) {
    this.triggers.remove(order.orderId);
    this.stops.remove(order.orderId);
  }

  private persistStatus(order: RestingOrder) {
    order.updatedAtMs = Date.now();
    this.ctx.journal
      ?.prepare("UPDATE resting_orders SET status=?,updated_ms=?,tx_hash=?,last_error=? WHERE order_id=?")
      .run(
        order.status,
        order.updatedAtMs,
        order.transactionHash ?? null,
        order.lastError ?? null,
        order.orderId,
      );
  }

  /** Live orders signed with the same account and nonce (the other leg of a TP/SL pair). */
  private siblings(order: RestingOrder) {
    return [...this.orders.values()].filter(
      (other) =>
        other.orderId !== order.orderId &&
        other.userSignature !== undefined &&
        isLive(other) &&
        other.intent.account === order.intent.account &&
        other.intent.nonce === order.intent.nonce,
    );
  }

  /** The nonce is spent on chain: every live order sharing it is closed. */
  private closeSiblings(order: RestingOrder, note: string) {
    for (const other of this.siblings(order)) {
      other.status = "cancelled";
      other.lastError = note;
      this.disarm(other);
      this.persistStatus(other);
    }
  }

  scheduleCheck(delay = ORDER_CHECK_DELAY_MS) {
    if (this.checking) {
      this.checkQueued = true;
      return;
    }
    if (this.checkTimer) return;
    this.checkTimer = setTimeout(() => {
      this.checkTimer = undefined;
      void this.checkRestingOrders();
    }, delay);
    this.checkTimer.unref();
  }

  /** The latest oracle mid for trigger checks; without an oracle source the configured price. */
  private async currentMid(market: Market) {
    const source = this.ctx.options.oracleSource;
    if (source) {
      try {
        this.ctx.prices[market] = (await source.latest(market)).snapshot;
      } catch {
        return undefined;
      }
    }
    const price = this.ctx.prices[market];
    if (!price) return undefined;
    const { bid, ask } = price;
    return (bid + ask) / 2n;
  }

  private async checkRestingOrders() {
    if (this.checking) return;
    this.checking = true;
    try {
      for (const id of [...this.triggers.takeExpired(), ...this.stops.takeExpired()]) {
        const order = this.orders.get(id);
        if (!order || order.status !== "open") continue;
        order.status = "expired";
        this.persistStatus(order);
      }
      await this.sweepReduceOnly();
      const { prices } = this.ctx;
      const candidates = marketSymbols().flatMap((market) => {
        const price = prices[market];
        return price
          ? this.triggers.takeMarketable(market, price.bid, price.ask, MAX_TRIGGERS_PER_MARKET)
          : [];
      });
      for (const id of candidates) {
        const order = this.orders.get(id);
        if (order && order.status === "open" && order.userSignature)
          await this.tryExecute(order, order.userSignature);
      }
      for (const market of marketSymbols()) {
        if (this.stops.size === 0) break;
        const mid = await this.currentMid(market);
        if (mid === undefined) continue;
        for (const id of this.stops.takeTriggered(market, mid, MAX_TRIGGERS_PER_MARKET)) {
          const order = this.orders.get(id);
          if (order && order.status === "open" && order.userSignature) await this.tryExecuteTrigger(order);
        }
      }
    } finally {
      this.checking = false;
      if (this.checkQueued) {
        this.checkQueued = false;
        this.scheduleCheck();
      }
    }
  }

  /**
   * Reduce-only trigger orders whose position has closed (or flipped to their side) are cancelled off
   * chain and never fired. They remain signed and executable on chain until their deadline or a nonce
   * cancel, so the leader simply stops acting on them.
   */
  private async sweepReduceOnly() {
    const { clearing } = this.ctx;
    if (!clearing || this.positionSweeps.size === 0) return;
    const keys = [...this.positionSweeps].slice(0, MAX_POSITION_SWEEP);
    for (const key of keys) {
      this.positionSweeps.delete(key);
      const [account, market] = key.split(":") as [string, Market];
      const affected = [...this.orders.values()].filter(
        (order) =>
          order.trigger &&
          order.intent.reduceOnly &&
          order.status === "open" &&
          order.intent.account === account &&
          order.market === market,
      );
      if (!affected.length) continue;
      let size: bigint;
      try {
        size = BigInt((await clearing.positionOf(account, marketIndex(market))).size);
      } catch {
        this.positionSweeps.add(key);
        continue;
      }
      for (const order of affected)
        if (!reducible(size, order.intent.baseDelta)) this.cancelOffChain(order, POSITION_CLOSED_NOTE);
    }
  }

  private cancelOffChain(order: RestingOrder, note: string) {
    order.status = "cancelled";
    order.lastError = note;
    this.disarm(order);
    this.persistStatus(order);
  }

  /** A spent nonce closes the order: filled if this leader settled it, otherwise cancelled. */
  private async nonceSpent(order: RestingOrder) {
    const { clearing } = this.ctx;
    if (!clearing || !(await clearing.nonceUsed(order.intent.account, order.intent.nonce).catch(() => false)))
      return false;
    order.status = order.transactionHash ? "filled" : "cancelled";
    this.persistStatus(order);
    this.closeSiblings(order, "cancelled by another order with the same nonce");
    return true;
  }

  private async tryExecute(order: RestingOrder, userSignature: string) {
    const { ctx } = this;
    if (await this.nonceSpent(order)) return;
    try {
      const snapshot = ctx.prices[order.market];
      if (!snapshot) return this.arm(order);
      const notional = (abs(order.intent.baseDelta) * ((snapshot.bid + snapshot.ask) / 2n)) / BASE;
      if (notional <= 0n) return;
      const request = { market: order.market, side: order.side, amount: formatUsdc(notional) };
      // An indicative quote first, so a stored firm quote is only spent on orders that cross.
      const indicative = await this.quoting.createQuote(request, { persist: false });
      if (!marketable(order, indicative.quote.expectedPrice)) return this.arm(order);
      const { quote } = await this.quoting.createQuote(request);
      quote.baseDelta = order.intent.baseDelta;
      quote.delta = order.side === "buy" ? notional : -notional;
      quote.notional = notional;
      if (!marketable(order, quote.expectedPrice)) return this.arm(order);
      ctx.quotes.bind(quote.quoteId, order.intent);
      await this.submit(order, quote.quoteId, userSignature);
    } catch (error) {
      order.status = "open";
      this.arm(order);
      order.lastError = publicError(error, "execution unavailable");
      this.persistStatus(order);
    }
  }

  /**
   * Fire a crossed trigger: price the fill (a reduce-only order clamped to the position, as the
   * contract clamps it), require the quote's touch to still satisfy the trigger and its price to
   * respect the signed limit, then execute through the market-order path. Otherwise re-arm.
   */
  private async tryExecuteTrigger(order: RestingOrder) {
    const { ctx } = this,
      terms = order.trigger!,
      trigger: Trigger = { triggerPrice: terms.triggerPrice, triggerAbove: terms.triggerAbove };
    if (await this.nonceSpent(order)) return;
    try {
      let fill = order.intent.baseDelta;
      if (ctx.clearing) {
        const size = BigInt((await ctx.clearing.positionOf(order.intent.account, order.intent.market)).size);
        if (order.intent.reduceOnly && !reducible(size, order.intent.baseDelta))
          return this.cancelOffChain(order, POSITION_CLOSED_NOTE);
        fill = triggeredFillDelta(order.intent, size);
      }
      const request = { market: order.market, side: order.side, amount: "1" },
        options = { exactBaseDelta: fill, reductionAccount: order.intent.account },
        crossed = (bid: bigint, ask: bigint, price: bigint) =>
          triggerReached(bid, ask, trigger) && marketable(order, price);
      const indicative = await this.quoting.createQuote(request, { ...options, persist: false });
      if (
        !crossed(indicative.quote.snapshot.bid, indicative.quote.snapshot.ask, indicative.quote.expectedPrice)
      )
        return this.waitForPrice(order, indicative.quote.snapshot, indicative.quote.expectedPrice, trigger);
      const { quote } = await this.quoting.createQuote(request, options);
      if (!crossed(quote.snapshot.bid, quote.snapshot.ask, quote.expectedPrice))
        return this.waitForPrice(order, quote.snapshot, quote.expectedPrice, trigger);
      ctx.quotes.bind(quote.quoteId, order.intent);
      ctx.quotes.triggers.set(quote.quoteId, trigger);
      await this.submit(order, quote.quoteId, order.userSignature!);
    } catch (error) {
      order.status = "open";
      this.arm(order);
      order.lastError = publicError(error, "execution unavailable");
      this.persistStatus(order);
    }
  }

  /**
   * Re-arm a trigger that did not fire. When the trigger is met but the fill would break the signed
   * limit (the price gapped through the slippage band), say so on the order once.
   */
  private waitForPrice(
    order: RestingOrder,
    snapshot: { bid: bigint; ask: bigint },
    price: bigint,
    trigger: Trigger,
  ) {
    this.arm(order);
    const note =
      triggerReached(snapshot.bid, snapshot.ask, trigger) && !marketable(order, price)
        ? PAST_LIMIT_NOTE
        : undefined;
    if (note === order.lastError || (note === undefined && order.lastError !== PAST_LIMIT_NOTE)) return;
    order.lastError = note;
    this.persistStatus(order);
  }

  /** Execute a bound quote for an order; re-arms it with the reason when execution fails. */
  private async submit(order: RestingOrder, quoteId: string, userSignature: string) {
    const { ctx } = this;
    order.status = "executing";
    this.persistStatus(order);
    // Internal execution calls the service directly: it must not spend the public write budget.
    const outcome = await this.execution.approve({
        quoteId,
        account: order.intent.account,
        nonce: order.intent.nonce.toString(),
        userSignature,
      }),
      body = outcome.body as ExecutionBody;
    ctx.quotes.preparedIntents.delete(quoteId);
    if (outcome.status === 200 && body.transaction) {
      order.status = "filled";
      order.transactionHash = body.transaction.hash;
      order.lastError = undefined;
      this.checkQueued = true;
      this.closeSiblings(order, "the other TP/SL leg filled");
    } else {
      const detail = Array.isArray(body.details) ? body.details.join("; ") : undefined;
      order.lastError = detail
        ? `${body.error}: ${detail}`
        : (body.error ?? `execution returned ${outcome.status}`);
      const refusal = executionRefusal(outcome.status, body, order.intent.reduceOnly);
      order.refusals = refusal === "transient" ? 0 : (order.refusals ?? 0) + 1;
      if (refusal === "margin")
        return this.cancelOffChain(order, `${MARGIN_CANCEL_NOTE} (${order.lastError})`);
      if (refusal === "refused" && order.refusals >= MAX_CONSECUTIVE_REFUSALS)
        return this.cancelOffChain(order, `${REFUSED_CANCEL_NOTE} (${order.lastError})`);
      order.status = "open";
      this.arm(order);
    }
    this.persistStatus(order);
  }

  /**
   * Build an unsigned triggered order. `baseDelta` is the signed size; the limit price is the trigger
   * moved `slippageBps` against the trader and the fee cap is 2 bps of the notional at the trigger
   * moved `slippageBps` up (the highest mid at which a fill can still respect the band).
   */
  private async buildTriggerOrder(input: {
    account: string;
    market: Market;
    kind: TriggerKind;
    side: Side;
    baseDelta: bigint;
    amount: string;
    triggerPrice: bigint;
    slippageBps: number;
    durationSeconds: number;
    nonce: string;
    reduceOnly: boolean;
    sizing: "amount" | "position";
    pairId?: string;
    blockTimestamp: number;
    mid: bigint;
  }) {
    const { triggerPrice, side, kind } = input,
      slippage = BigInt(input.slippageBps),
      trigger: Trigger = { triggerPrice, triggerAbove: triggerAboveFor(kind, side) };
    if (input.baseDelta === 0n || input.baseDelta > 0n !== (side === "buy"))
      throw new OrderRejection(409, "order size rounds to zero");
    // An order whose trigger is already met would fire at once; that is a market or limit order.
    if (trigger.triggerAbove ? input.mid >= triggerPrice : input.mid <= triggerPrice)
      throw new OrderRejection(
        409,
        `${TRIGGER_WORDS[kind]} price must be ${trigger.triggerAbove ? "above" : "below"} the current price`,
      );
    const limitPrice = triggerLimitPrice(triggerPrice, side, slippage),
      // The fee cap covers the best fill price the order can get: a buy is capped at its limit, but a sell
      // has no upper bound, so a take-profit that gaps through its trigger allows up to twice the trigger.
      feePrice = side === "buy" ? limitPrice : triggerPrice * 2n,
      intent: TradeIntent = {
        account: input.account,
        market: marketIndex(input.market),
        baseDelta: input.baseDelta,
        limitPrice,
        maxFee: ceilDiv(((abs(input.baseDelta) * feePrice) / BASE) * ORDER_FEE_BPS, 10_000n),
        nonce: BigInt(input.nonce),
        deadline: BigInt(input.blockTimestamp + input.durationSeconds),
        reduceOnly: input.reduceOnly,
      },
      now = Date.now(),
      order: RestingOrder = {
        orderId: crypto.randomUUID(),
        type: kind,
        intent,
        trigger: { ...trigger, slippageBps: input.slippageBps, sizing: input.sizing, pairId: input.pairId },
        market: input.market,
        side,
        amount: input.amount,
        status: "prepared",
        createdAtMs: now,
        updatedAtMs: now,
      };
    return order;
  }

  private stagePrepared(order: RestingOrder) {
    this.orders.set(order.orderId, order);
    this.preparedExpiries.schedule(order.orderId, order.createdAtMs + PREPARED_ORDER_TTL_MS);
  }

  /** The typed data a wallet signs for a prepared trigger order, with a readable summary. */
  private preparedTrigger(order: RestingOrder) {
    const terms = order.trigger!,
      trigger: Trigger = { triggerPrice: terms.triggerPrice, triggerAbove: terms.triggerAbove };
    return {
      orderId: order.orderId,
      type: order.type,
      domain: this.ctx.wireDomain,
      types: triggeredIntentTypes,
      intent: triggeredIntentToWire(order.intent, trigger),
      trigger: triggerToWire(trigger),
      summary: {
        market: order.market,
        side: order.side,
        type: order.type,
        amount: order.amount,
        sizing: terms.sizing,
        baseDelta: order.intent.baseDelta.toString(),
        triggerPrice: terms.triggerPrice.toString(),
        triggerAbove: terms.triggerAbove,
        limitPrice: order.intent.limitPrice.toString(),
        slippageBps: terms.slippageBps,
        maxFee: order.intent.maxFee.toString(),
        reduceOnly: order.intent.reduceOnly,
        pairId: terms.pairId ?? null,
        expiresAtMs: Number(order.intent.deadline) * 1_000,
      },
    };
  }

  private orderView(order: RestingOrder) {
    return {
      orderId: order.orderId,
      type: order.type,
      market: order.market,
      side: order.side,
      amount: order.amount,
      baseDelta: order.intent.baseDelta.toString(),
      limitPrice: order.intent.limitPrice.toString(),
      triggerPrice: order.trigger?.triggerPrice.toString() ?? null,
      triggerAbove: order.trigger?.triggerAbove ?? null,
      slippageBps: order.trigger?.slippageBps ?? null,
      sizing: order.trigger?.sizing ?? null,
      pairId: order.trigger?.pairId ?? null,
      reduceOnly: order.intent.reduceOnly,
      maxFee: order.intent.maxFee.toString(),
      nonce: order.intent.nonce.toString(),
      expiresAtMs: Number(order.intent.deadline) * 1_000,
      status: order.status,
      transactionHash: order.transactionHash,
      lastError: order.lastError,
    };
  }

  private async positionSize(account: string, market: Market) {
    if (!this.ctx.clearing) throw new OrderRejection(503, "chain unavailable");
    return BigInt((await this.ctx.clearing.positionOf(account, marketIndex(market))).size);
  }

  register(app: FastifyInstance, guards: HttpGuards) {
    const { ctx } = this;
    app.post("/v1/orders/prepare", async (request, reply) => {
      if (!guards.admitQuoteWork(request, reply)) return;
      const parsed = orderPrepareSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: "invalid limit order" });
      const { market, side, amount, durationSeconds, nonce, reduceOnly } = parsed.data;
      try {
        const account = getAddress(parsed.data.account);
        this.assertCanPrepare(account);
        const { quote, versions } = await this.quoting.createQuote(
            { market, side, amount },
            { persist: false },
          ),
          limitPrice = parseUnits(parsed.data.limitPrice, 6);
        if (limitPrice <= 0n) throw new Error("invalid limit price");
        const intent: TradeIntent = {
            account,
            market: marketIndex(market),
            baseDelta: quote.baseDelta,
            limitPrice,
            maxFee: ceilDiv(((abs(quote.baseDelta) * limitPrice) / BASE) * ORDER_FEE_BPS, 10_000n),
            nonce: BigInt(nonce),
            deadline: BigInt(versions.blockTimestamp + durationSeconds),
            reduceOnly,
          },
          now = Date.now(),
          order: RestingOrder = {
            orderId: crypto.randomUUID(),
            type: "limit",
            intent,
            market,
            side,
            amount,
            status: "prepared",
            createdAtMs: now,
            updatedAtMs: now,
          };
        this.stagePrepared(order);
        return {
          orderId: order.orderId,
          type: order.type,
          domain: ctx.wireDomain,
          types: intentTypes,
          intent: intentToWire(intent),
          summary: {
            market,
            side,
            amount,
            baseDelta: intent.baseDelta.toString(),
            limitPrice: intent.limitPrice.toString(),
            maxFee: intent.maxFee.toString(),
            expiresAtMs: Number(intent.deadline) * 1_000,
          },
        };
      } catch (error) {
        const status = error instanceof OrderRejection ? error.status : 409;
        return reply.code(status).send({ error: publicError(error, "limit order rejected") });
      }
    });

    app.post("/v1/orders/trigger/prepare", async (request, reply) => {
      if (!guards.admitQuoteWork(request, reply)) return;
      const parsed = triggerOrderPrepareSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: "invalid trigger order" });
      const input = parsed.data,
        protective = input.kind !== "stop-entry",
        reduceOnly = protective || (input.reduceOnly ?? false);
      if (protective && input.reduceOnly === false)
        return reply.code(400).send({ error: "stop-loss and take-profit orders are reduce-only" });
      if (input.sizing === "amount" && (!input.side || !input.amount))
        return reply.code(400).send({ error: "amount sizing requires side and amount" });
      if (input.sizing === "position" && !reduceOnly)
        return reply.code(400).send({ error: "position sizing is reduce-only" });
      try {
        const account = getAddress(input.account),
          triggerPrice = parseUsdc(input.triggerPrice);
        this.assertCanPrepare(account);
        if (triggerPrice <= 0n) throw new OrderRejection(400, "invalid trigger price");
        let side: Side, baseDelta: bigint, amount: string;
        if (input.sizing === "position") {
          const size = await this.positionSize(account, input.market);
          if (size === 0n) throw new OrderRejection(409, "no open position");
          side = size > 0n ? "sell" : "buy";
          if (input.side && input.side !== side)
            throw new OrderRejection(400, "side must close the position");
          baseDelta = -size;
          amount = formatUsdc((abs(size) * triggerPrice) / BASE);
        } else {
          side = input.side!;
          amount = input.amount!;
          const base = (parseUsdc(amount) * BASE) / triggerPrice;
          baseDelta = side === "buy" ? base : -base;
          // A protective order needs a position it can reduce; checked when a chain is attached.
          if (
            protective &&
            ctx.clearing &&
            !reducible(await this.positionSize(account, input.market), baseDelta)
          )
            throw new OrderRejection(409, "no position for this order to reduce");
        }
        if (input.triggerAbove !== undefined && input.triggerAbove !== triggerAboveFor(input.kind, side))
          throw new OrderRejection(400, "triggerAbove contradicts the order kind and side");
        const [versions, mid] = await Promise.all([
          this.chain.readProtocolVersions(),
          this.currentMid(input.market),
        ]);
        if (mid === undefined) throw new OrderRejection(503, "oracle unavailable");
        const order = await this.buildTriggerOrder({
          account,
          market: input.market,
          kind: input.kind,
          side,
          baseDelta,
          amount,
          triggerPrice,
          slippageBps: input.slippageBps,
          durationSeconds: input.durationSeconds,
          nonce: input.nonce,
          reduceOnly,
          sizing: input.sizing,
          blockTimestamp: versions.blockTimestamp,
          mid,
        });
        this.stagePrepared(order);
        return this.preparedTrigger(order);
      } catch (error) {
        return rejectOrder(reply, error, "trigger order rejected");
      }
    });

    // A take-profit and a stop-loss for the whole open position. Both legs share one nonce, so the
    // first to fill (or one nonce cancel) closes the other.
    app.post("/v1/orders/tpsl/prepare", async (request, reply) => {
      if (!guards.admitQuoteWork(request, reply)) return;
      const parsed = tpslPrepareSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: "invalid take-profit/stop-loss order" });
      const input = parsed.data;
      try {
        const account = getAddress(input.account);
        this.assertCanPrepare(account, 2);
        const size = await this.positionSize(account, input.market);
        if (size === 0n) throw new OrderRejection(409, "no open position");
        const [versions, mid] = await Promise.all([
          this.chain.readProtocolVersions(),
          this.currentMid(input.market),
        ]);
        if (mid === undefined) throw new OrderRejection(503, "oracle unavailable");
        const side: Side = size > 0n ? "sell" : "buy",
          pairId = crypto.randomUUID(),
          legs: Array<[TriggerKind, string | undefined]> = [
            ["take-profit", input.takeProfitPrice],
            ["stop-loss", input.stopLossPrice],
          ],
          orders: RestingOrder[] = [];
        for (const [kind, price] of legs) {
          if (price === undefined) continue;
          const triggerPrice = parseUsdc(price);
          if (triggerPrice <= 0n) throw new OrderRejection(400, "invalid trigger price");
          orders.push(
            await this.buildTriggerOrder({
              account,
              market: input.market,
              kind,
              side,
              baseDelta: -size,
              amount: formatUsdc((abs(size) * triggerPrice) / BASE),
              triggerPrice,
              slippageBps: input.slippageBps,
              durationSeconds: input.durationSeconds,
              nonce: input.nonce,
              reduceOnly: true,
              sizing: "position",
              pairId,
              blockTimestamp: versions.blockTimestamp,
              mid,
            }),
          );
        }
        for (const order of orders) this.stagePrepared(order);
        return {
          pairId,
          nonce: input.nonce,
          orders: orders.map((order) => this.preparedTrigger(order)),
        };
      } catch (error) {
        return rejectOrder(reply, error, "take-profit/stop-loss rejected");
      }
    });

    app.post("/v1/orders", async (request, reply) => {
      const parsed = orderPlaceSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: "invalid signed order" });
      const order = this.orders.get(parsed.data.orderId);
      if (!order || order.status !== "prepared")
        return reply.code(404).send({ error: "prepared order not found" });
      ctx.prune();
      const full = this.placementRefusal(order);
      if (full) return reply.code(409).send({ error: full });
      const { userSignature } = parsed.data,
        trigger = order.trigger && {
          triggerPrice: order.trigger.triggerPrice,
          triggerAbove: order.trigger.triggerAbove,
        };
      if (
        !(await validOwnerSignature(
          // An isolated account's orders are signed by its owner.
          await signingAccount(ctx.clearing as IsolatedOwnerReader | undefined, order.intent.account),
          intentDigest(ctx.domain, order.intent, trigger),
          userSignature,
          ctx.provider,
        ))
      )
        return reply.code(401).send({ error: "invalid order signature" });
      try {
        await this.assertFunded(order);
      } catch (error) {
        const status = error instanceof OrderRejection ? error.status : 409;
        return reply.code(status).send({ error: publicError(error, "order rejected") });
      }
      // The signature and funding reads awaited: re-check that the order is still placeable.
      if (order.status !== "prepared" || this.orders.get(order.orderId) !== order)
        return reply.code(404).send({ error: "prepared order not found" });
      const filled = this.placementRefusal(order);
      if (filled) return reply.code(409).send({ error: filled });
      order.userSignature = userSignature;
      order.status = "open";
      order.updatedAtMs = Date.now();
      this.preparedExpiries.cancel(order.orderId);
      this.arm(order);
      ctx.journal
        ?.prepare(
          "INSERT INTO resting_orders(order_id,account,market,side,amount,intent_json,user_signature,status,created_ms,updated_ms,tx_hash,last_error,order_type,trigger_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        )
        .run(
          order.orderId,
          order.intent.account,
          order.market,
          order.side,
          order.amount,
          JSON.stringify(intentToWire(order.intent)),
          userSignature,
          order.status,
          order.createdAtMs,
          order.updatedAtMs,
          null,
          null,
          order.type,
          order.trigger ? triggerTermsToJson(order.trigger) : null,
        );
      this.scheduleCheck();
      return {
        orderId: order.orderId,
        type: order.type,
        status: order.status,
        intent: intentToWire(order.intent),
        ...(trigger ? { trigger: triggerToWire(trigger) } : {}),
      };
    });

    app.get("/v1/orders/:address", async (request, reply) => {
      let account: string;
      try {
        account = getAddress((request.params as { address: string }).address);
      } catch {
        return reply.code(400).send({ error: "invalid account" });
      }
      return {
        items: [...this.orders.values()]
          .filter((order) => order.intent.account === account && order.status !== "prepared")
          .sort((a, b) => b.createdAtMs - a.createdAtMs)
          .map((order) => this.orderView(order)),
      };
    });

    app.post("/v1/orders/:orderId/cancel/prepare", async (request, reply) => {
      const order = this.orders.get((request.params as { orderId: string }).orderId);
      if (!order || !order.userSignature) return reply.code(404).send({ error: "order not found" });
      if (!isLive(order)) return reply.code(409).send({ error: `order is already ${order.status}` });
      const intent: CancelIntent = {
        account: order.intent.account,
        nonce: order.intent.nonce,
        deadline: BigInt((await this.chain.chainTimestamp()) + CANCEL_TTL_SECONDS),
      };
      return {
        domain: ctx.wireDomain,
        types: cancelTypes,
        intent: cancelToWire(intent),
        // Cancelling the nonce cancels every order signed with it (both legs of a TP/SL pair).
        orderIds: [order.orderId, ...this.siblings(order).map((other) => other.orderId)],
      };
    });

    app.post("/v1/orders/:orderId/cancel", async (request, reply) => {
      const order = this.orders.get((request.params as { orderId: string }).orderId),
        parsed = cancelExecuteSchema.safeParse(request.body);
      if (!order || !parsed.success) return reply.code(400).send({ error: "invalid order cancellation" });
      if (!isLive(order)) return reply.code(409).send({ error: `order is already ${order.status}` });
      const { userSignature } = parsed.data;
      try {
        const intent: CancelIntent = {
          account: getAddress(parsed.data.intent.account),
          nonce: BigInt(parsed.data.intent.nonce),
          deadline: BigInt(parsed.data.intent.deadline),
        };
        if (
          intent.account !== order.intent.account ||
          intent.nonce !== order.intent.nonce ||
          !(await verifySignedAction(ctx, cancelTypes, intent, userSignature))
        )
          return reply.code(401).send({ error: "invalid cancellation signature" });
        const chain = ctx.chain;
        if (!chain || !ctx.sender) return reply.code(503).send({ error: "chain unavailable" });
        const refused = await admitSponsoredAction(ctx, intent.account);
        if (refused) return refused.send(reply);
        const receipt = await ctx.sender.submit(
          `cancel-order:${order.orderId}`,
          {
            to: chain.config.clearingAddress,
            data: chain.clearing.interface.encodeFunctionData("cancelNonceWithSignature", [
              intent.account,
              intent.nonce,
              intent.deadline,
              userSignature,
            ]),
          },
          { deadline: Number(intent.deadline) },
        );
        const cancelled = [order, ...this.siblings(order)];
        for (const item of cancelled) {
          item.status = "cancelled";
          item.transactionHash = receipt.hash;
          this.disarm(item);
          this.persistStatus(item);
        }
        return {
          orderId: order.orderId,
          status: order.status,
          cancelledOrderIds: cancelled.map((item) => item.orderId),
          transaction: { hash: receipt.hash, blockNumber: receipt.blockNumber },
        };
      } catch (error) {
        return reply.code(409).send({ error: publicError(error, "cancellation failed") });
      }
    });
  }

  start() {
    this.reconcileTimer = setInterval(() => {
      // Positions also change outside this leader (liquidations, owner closes on chain).
      for (const order of this.orders.values())
        if (order.trigger && order.intent.reduceOnly && order.status === "open")
          this.positionSweeps.add(positionKey(order.intent.account, order.market));
      this.scheduleCheck();
    }, ORDER_RECONCILE_MS);
    this.reconcileTimer.unref();
  }

  close() {
    if (this.checkTimer) clearTimeout(this.checkTimer);
    if (this.reconcileTimer) clearInterval(this.reconcileTimer);
  }
}
