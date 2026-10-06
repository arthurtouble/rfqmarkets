import { getAddress, parseUnits } from "ethers";
import type { FastifyInstance } from "fastify";
import {
  cancelToWire,
  cancelTypes,
  hashIntent,
  intentToWire,
  intentTypes,
  type CancelIntent,
  type TradeIntent,
} from "../../../packages/shared/src/eip712.js";
import { BASE, ceilDiv, formatUsdc } from "../../../packages/shared/src/policy.js";
import { ExpiryIndex } from "./bounded-state.js";
import type { ChainReader } from "./chain.js";
import type { ApiContext } from "./context.js";
import type { ExecutionService } from "./execution.js";
import type { HttpGuards } from "./http.js";
import { LimitTriggerBook } from "./limit-book.js";
import { abs, marketIndex, type Market, type Side } from "./markets.js";
import { validOwnerSignature } from "./owner-signature.js";
import { publicError } from "./public-error.js";
import type { QuoteEngine } from "./quoting.js";
import { cancelExecuteSchema, orderPlaceSchema, orderPrepareSchema } from "./schemas.js";
import { verifySignedAction } from "./signed-actions.js";

type OrderStatus = "prepared" | "open" | "executing" | "filled" | "cancelled" | "expired";
type RestingOrder = {
  orderId: string;
  intent: TradeIntent;
  market: Market;
  side: Side;
  amount: string;
  userSignature?: string;
  status: OrderStatus;
  createdAtMs: number;
  updatedAtMs: number;
  transactionHash?: string;
  lastError?: string;
};

/** Unsigned prepared orders are dropped after five minutes. */
const PREPARED_ORDER_TTL_MS = 300_000;
/** Limit orders cap their fee at 2 bps of the notional at the limit price. */
const ORDER_FEE_BPS = 2n;
const MAX_TRIGGERS_PER_MARKET = 16;
const ORDER_CHECK_DELAY_MS = 25;
const ORDER_RECONCILE_MS = 30_000;
const CANCEL_TTL_SECONDS = 120;

const isLive = (order: RestingOrder) =>
  order.status === "prepared" || order.status === "open" || order.status === "executing";
const marketable = (order: RestingOrder, price: bigint) =>
  order.side === "buy" ? price <= order.intent.limitPrice : price >= order.intent.limitPrice;

/**
 * Resting all-or-none limit orders. Each order is a signed trade intent held off chain and executed
 * through the market-order path once a firm quote crosses its limit price.
 */
export class LimitOrders {
  private readonly orders = new Map<string, RestingOrder>();
  private readonly triggers = new LimitTriggerBook();
  private readonly preparedExpiries = new ExpiryIndex();
  private readonly capacity: number;
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
    this.restore();
    ctx.onPrune((now) => {
      for (const id of this.preparedExpiries.takeExpired(now))
        if (this.orders.get(id)?.status === "prepared") this.orders.delete(id);
    });
  }

  get stats() {
    let active = 0;
    for (const order of this.orders.values()) if (isLive(order)) active++;
    return { active, indexed: this.triggers.size, capacity: this.capacity };
  }

  private restore() {
    const rows =
      this.ctx.journal?.prepare("SELECT * FROM resting_orders WHERE status IN ('open','executing')").all() ??
      [];
    for (const row of rows) {
      const item = row as Record<string, string | number | null>,
        wire = JSON.parse(String(item.intent_json));
      const order: RestingOrder = {
        orderId: String(item.order_id),
        intent: {
          ...wire,
          account: getAddress(wire.account),
          baseDelta: BigInt(wire.baseDelta),
          limitPrice: BigInt(wire.limitPrice),
          maxFee: BigInt(wire.maxFee),
          nonce: BigInt(wire.nonce),
          deadline: BigInt(wire.deadline),
        },
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
      this.orders.set(order.orderId, order);
      this.arm(order);
    }
  }

  /** (Re-)index an open order in the trigger book. */
  private arm(order: RestingOrder) {
    this.triggers.add(
      order.orderId,
      order.market,
      order.side,
      order.intent.limitPrice,
      Number(order.intent.deadline) * 1_000,
    );
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

  private async checkRestingOrders() {
    if (this.checking) return;
    this.checking = true;
    try {
      for (const id of this.triggers.takeExpired()) {
        const order = this.orders.get(id);
        if (!order || order.status !== "open") continue;
        order.status = "expired";
        this.persistStatus(order);
      }
      const { prices } = this.ctx;
      const candidates = [
        ...this.triggers.takeMarketable("BTC", prices.BTC.bid, prices.BTC.ask, MAX_TRIGGERS_PER_MARKET),
        ...this.triggers.takeMarketable("ETH", prices.ETH.bid, prices.ETH.ask, MAX_TRIGGERS_PER_MARKET),
      ];
      for (const id of candidates) {
        const order = this.orders.get(id);
        if (order && order.status === "open" && order.userSignature)
          await this.tryExecute(order, order.userSignature);
      }
    } finally {
      this.checking = false;
      if (this.checkQueued) {
        this.checkQueued = false;
        this.scheduleCheck();
      }
    }
  }

  private async tryExecute(order: RestingOrder, userSignature: string) {
    const { ctx } = this;
    if (
      ctx.clearing &&
      (await ctx.clearing.nonceUsed(order.intent.account, order.intent.nonce).catch(() => false))
    ) {
      order.status = order.transactionHash ? "filled" : "cancelled";
      this.persistStatus(order);
      return;
    }
    try {
      const snapshot = ctx.prices[order.market],
        notional = (abs(order.intent.baseDelta) * ((snapshot.bid + snapshot.ask) / 2n)) / BASE;
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
      order.status = "executing";
      this.persistStatus(order);
      // Internal execution calls the service directly: it must not spend the public write budget.
      const outcome = await this.execution.approve({
          quoteId: quote.quoteId,
          account: order.intent.account,
          nonce: order.intent.nonce.toString(),
          userSignature,
        }),
        body = outcome.body as { transaction?: { hash: string }; error?: string; details?: unknown };
      ctx.quotes.preparedIntents.delete(quote.quoteId);
      if (outcome.status === 200 && body.transaction) {
        order.status = "filled";
        order.transactionHash = body.transaction.hash;
        order.lastError = undefined;
        this.checkQueued = true;
      } else {
        order.status = "open";
        this.arm(order);
        const detail = Array.isArray(body.details) ? body.details.join("; ") : undefined;
        order.lastError = detail
          ? `${body.error}: ${detail}`
          : (body.error ?? `execution returned ${outcome.status}`);
      }
      this.persistStatus(order);
    } catch (error) {
      order.status = "open";
      this.arm(order);
      order.lastError = publicError(error, "execution unavailable");
      this.persistStatus(order);
    }
  }

  register(app: FastifyInstance, guards: HttpGuards) {
    const { ctx } = this;
    app.post("/v1/orders/prepare", async (request, reply) => {
      if (!guards.admitQuoteWork(request, reply)) return;
      const parsed = orderPrepareSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: "invalid limit order" });
      const { market, side, amount, durationSeconds, nonce, reduceOnly } = parsed.data;
      try {
        ctx.prune();
        if (this.stats.active >= this.capacity) throw new Error("order capacity reached");
        const account = getAddress(parsed.data.account),
          { quote, versions } = await this.quoting.createQuote({ market, side, amount }, { persist: false }),
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
            intent,
            market,
            side,
            amount,
            status: "prepared",
            createdAtMs: now,
            updatedAtMs: now,
          };
        this.orders.set(order.orderId, order);
        this.preparedExpiries.schedule(order.orderId, now + PREPARED_ORDER_TTL_MS);
        return {
          orderId: order.orderId,
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
        return reply.code(409).send({ error: publicError(error, "limit order rejected") });
      }
    });

    app.post("/v1/orders", async (request, reply) => {
      const parsed = orderPlaceSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: "invalid signed order" });
      const order = this.orders.get(parsed.data.orderId);
      if (!order || order.status !== "prepared")
        return reply.code(404).send({ error: "prepared order not found" });
      const { userSignature } = parsed.data;
      if (
        !(await validOwnerSignature(
          order.intent.account,
          hashIntent(ctx.domain, order.intent),
          userSignature,
          ctx.provider,
        ))
      )
        return reply.code(401).send({ error: "invalid order signature" });
      order.userSignature = userSignature;
      order.status = "open";
      order.updatedAtMs = Date.now();
      this.preparedExpiries.cancel(order.orderId);
      this.arm(order);
      ctx.journal
        ?.prepare("INSERT INTO resting_orders VALUES(?,?,?,?,?,?,?,?,?,?,?,?)")
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
        );
      this.scheduleCheck();
      return { orderId: order.orderId, status: order.status, intent: intentToWire(order.intent) };
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
          .map((order) => ({
            orderId: order.orderId,
            market: order.market,
            side: order.side,
            amount: order.amount,
            baseDelta: order.intent.baseDelta.toString(),
            limitPrice: order.intent.limitPrice.toString(),
            maxFee: order.intent.maxFee.toString(),
            nonce: order.intent.nonce.toString(),
            expiresAtMs: Number(order.intent.deadline) * 1_000,
            status: order.status,
            transactionHash: order.transactionHash,
            lastError: order.lastError,
          })),
      };
    });

    app.post("/v1/orders/:orderId/cancel/prepare", async (request, reply) => {
      const order = this.orders.get((request.params as { orderId: string }).orderId);
      if (!order || !order.userSignature) return reply.code(404).send({ error: "order not found" });
      const intent: CancelIntent = {
        account: order.intent.account,
        nonce: order.intent.nonce,
        deadline: BigInt((await this.chain.chainTimestamp()) + CANCEL_TTL_SECONDS),
      };
      return { domain: ctx.wireDomain, types: cancelTypes, intent: cancelToWire(intent) };
    });

    app.post("/v1/orders/:orderId/cancel", async (request, reply) => {
      const order = this.orders.get((request.params as { orderId: string }).orderId),
        parsed = cancelExecuteSchema.safeParse(request.body);
      if (!order || !parsed.success) return reply.code(400).send({ error: "invalid order cancellation" });
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
        const receipt = await ctx.sender.submit(`cancel-order:${order.orderId}`, {
          to: chain.config.clearingAddress,
          data: chain.clearing.interface.encodeFunctionData("cancelNonceWithSignature", [
            intent.account,
            intent.nonce,
            intent.deadline,
            userSignature,
          ]),
        });
        order.status = "cancelled";
        order.transactionHash = receipt.hash;
        this.triggers.remove(order.orderId);
        this.persistStatus(order);
        return {
          orderId: order.orderId,
          status: order.status,
          transaction: { hash: receipt.hash, blockNumber: receipt.blockNumber },
        };
      } catch (error) {
        return reply.code(409).send({ error: publicError(error, "cancellation failed") });
      }
    });
  }

  start() {
    this.reconcileTimer = setInterval(() => this.scheduleCheck(), ORDER_RECONCILE_MS);
    this.reconcileTimer.unref();
  }

  close() {
    if (this.checkTimer) clearTimeout(this.checkTimer);
    if (this.reconcileTimer) clearInterval(this.reconcileTimer);
  }
}
