import assert from "node:assert/strict";
import { test } from "node:test";
import {
  closeFractionBps, isTriggerOrder, pairedOrder, protectiveOrders, sessionCoversDeadline, tpslPrepareBody, tpslProblem,
  triggerPrepareBody, triggerProblem, TRIGGER_ORDER_DURATION_SECONDS,
} from "./orders.js";
import type { RestingOrder } from "./types.js";

const USDC = 1_000_000n, BASE = 10n ** 18n, ACCOUNT = "0x0000000000000000000000000000000000000001";

test("trigger bodies size by amount or position and derive the direction", () => {
  assert.deepEqual(triggerPrepareBody({ market: "BTC", kind: "stop-loss", side: "sell", amountMicro: 500n * USDC, triggerPriceMicro: 90_000n * USDC }, ACCOUNT, "7"), {
    account: ACCOUNT, market: "BTC", kind: "stop-loss", triggerPrice: "90000", slippageBps: 100,
    durationSeconds: TRIGGER_ORDER_DURATION_SECONDS, nonce: "7", sizing: "amount", side: "sell", amount: "500",
    triggerAbove: false, reduceOnly: true,
  });
  const entry = triggerPrepareBody({ market: "ETH", kind: "stop-entry", side: "buy", amountMicro: 1_250_500_000n, triggerPriceMicro: 4_100_500_000n, slippageBps: 900, durationSeconds: 60 }, ACCOUNT, "8") as Record<string, unknown>;
  assert.equal(entry.triggerAbove, true);
  assert.equal(entry.reduceOnly, false);
  assert.equal(entry.amount, "1250.5");
  assert.equal(entry.triggerPrice, "4100.5");
  assert.equal(entry.slippageBps, 500);
  assert.equal(entry.durationSeconds, 300);
  assert.deepEqual(triggerPrepareBody({ market: "BTC", kind: "take-profit", sizing: "position", triggerPriceMicro: 120_000n * USDC }, ACCOUNT, "9"), {
    account: ACCOUNT, market: "BTC", kind: "take-profit", triggerPrice: "120000", slippageBps: 100,
    durationSeconds: TRIGGER_ORDER_DURATION_SECONDS, nonce: "9", sizing: "position", reduceOnly: true,
  });
  assert.throws(() => triggerPrepareBody({ market: "BTC", kind: "take-profit", side: "sell", amountMicro: 1n, triggerPriceMicro: 0n }, ACCOUNT, "1"));
  assert.throws(() => triggerPrepareBody({ market: "BTC", kind: "stop-loss", side: "sell", amountMicro: 1n, triggerPriceMicro: 1n, reduceOnly: false }, ACCOUNT, "1"));
});

test("TP/SL bodies need a price and both legs share one nonce", () => {
  assert.deepEqual(tpslPrepareBody({ market: "BTC", takeProfitMicro: 110_000n * USDC, stopLossMicro: 95_000n * USDC }, ACCOUNT, "5"), {
    account: ACCOUNT, market: "BTC", takeProfitPrice: "110000", stopLossPrice: "95000", slippageBps: 100,
    durationSeconds: TRIGGER_ORDER_DURATION_SECONDS, nonce: "5",
  });
  assert.equal("takeProfitPrice" in tpslPrepareBody({ market: "BTC", stopLossMicro: 1n }, ACCOUNT, "5"), false);
  assert.throws(() => tpslPrepareBody({ market: "BTC" }, ACCOUNT, "5"));
});

test("TP/SL and trigger checks reject already-reached prices", () => {
  const mid = 100_000n * USDC;
  assert.equal(tpslProblem(BASE, mid, 110_000n * USDC, 95_000n * USDC), null);
  assert.match(tpslProblem(BASE, mid, 99_000n * USDC)!, /above/);
  assert.match(tpslProblem(-BASE, mid, undefined, 99_000n * USDC)!, /above/);
  assert.equal(tpslProblem(-BASE, mid, 90_000n * USDC, 105_000n * USDC), null);
  assert.equal(tpslProblem(0n, mid, 1n), "No open position");
  assert.equal(triggerProblem("stop-entry", "buy", 101_000n * USDC, mid), null);
  assert.match(triggerProblem("stop-entry", "buy", 99_000n * USDC, mid)!, /above/);
  assert.equal(triggerProblem("stop-loss", "sell", 99_000n * USDC, mid), null);
});

test("close fractions, session deadlines and order filters", () => {
  assert.equal(closeFractionBps(25), 2_500);
  assert.equal(closeFractionBps(100), 10_000);
  assert.equal(closeFractionBps(150), 10_000);
  assert.equal(closeFractionBps(0.001), 1);
  assert.equal(closeFractionBps(0), null);
  assert.equal(sessionCoversDeadline(2_000, 1_000), true);
  assert.equal(sessionCoversDeadline(2_000, 2_001), false);
  assert.equal(sessionCoversDeadline(null, 1), false);

  const order = (orderId: string, extra: Partial<RestingOrder>): RestingOrder => ({
    orderId, market: "BTC", side: "sell", amount: "1", baseDelta: "-1", limitPrice: "1", maxFee: "0", nonce: "1", expiresAtMs: 0, status: "open", ...extra,
  });
  const tp = order("a", { type: "take-profit", pairId: "p" }), sl = order("b", { type: "stop-loss", pairId: "p" }), limit = order("c", {});
  assert.equal(isTriggerOrder(tp), true);
  assert.equal(isTriggerOrder(limit), false);
  assert.equal(pairedOrder(tp, [tp, sl, limit]), sl);
  assert.equal(pairedOrder(limit, [tp, sl, limit]), null);
  assert.deepEqual(protectiveOrders([tp, sl, limit, order("d", { type: "stop-loss", market: "ETH" })], "BTC"), [tp, sl]);
});
