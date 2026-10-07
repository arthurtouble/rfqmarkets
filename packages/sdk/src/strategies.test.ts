import assert from "node:assert/strict";
import { test } from "node:test";
import type { RfqClient } from "./client.js";
import {
  TrailingStop,
  fromMicro,
  placeScaleOrder,
  planScale,
  planTwap,
  runTrailingStop,
  runTwap,
  toMicro,
  trailingStopPrice,
} from "./strategies.js";

test("USDC amounts round-trip through micro units", () => {
  assert.equal(toMicro("95000.25"), 95_000_250_000n);
  assert.equal(fromMicro(95_000_250_000n), "95000.25");
  assert.equal(fromMicro(toMicro("7")), "7");
  assert.throws(() => toMicro("1.0000001"));
  assert.throws(() => toMicro("-1"));
});

test("scale plan spaces prices evenly and sizes add up exactly", () => {
  const plan = planScale({ totalAmount: "1000", fromPrice: "100", toPrice: "90", count: 5 });
  assert.deepEqual(
    plan.map((level) => level.limitPrice),
    ["100", "97.5", "95", "92.5", "90"],
  );
  assert.deepEqual(
    plan.map((level) => level.amount),
    ["200", "200", "200", "200", "200"],
  );
  const skewed = planScale({ totalAmount: "100", fromPrice: "1", toPrice: "2", count: 3, skew: 3 });
  assert.equal(
    skewed.reduce((sum, level) => sum + toMicro(level.amount), 0n),
    toMicro("100"),
  );
  assert(toMicro(skewed[2].amount) > toMicro(skewed[0].amount) * 2n);
  assert.throws(() => planScale({ totalAmount: "1", fromPrice: "1", toPrice: "2", count: 1 }));
  assert.throws(() => planScale({ totalAmount: "0.000001", fromPrice: "1", toPrice: "2", count: 3 }));
});

test("scale placement stops at the first rejection and returns what was placed", async () => {
  let calls = 0;
  const client = {
    limitOrder: async (input: { limitPrice: string }) => {
      if (++calls === 3) throw new Error("rejected");
      return { orderId: `order-${input.limitPrice}` };
    },
  } as unknown as RfqClient;
  const result = await placeScaleOrder(client, {
    market: "BTC",
    side: "buy",
    totalAmount: "400",
    fromPrice: "100",
    toPrice: "97",
    count: 4,
  });
  assert.equal(result.placed.length, 2);
  assert.match(String(result.error), /rejected/);
});

test("TWAP slices add up, wait between slices and stop on failure", async () => {
  assert.deepEqual(planTwap("10", 3), ["3.333333", "3.333333", "3.333334"]);
  const amounts: string[] = [],
    waits: number[] = [];
  const client = {
    trade: async (input: { amount: string }) => {
      amounts.push(input.amount);
      if (amounts.length === 3) throw new Error("no quote");
      return { ok: true };
    },
  } as unknown as RfqClient;
  const result = await runTwap(client, {
    market: "ETH",
    side: "sell",
    totalAmount: "400",
    slices: 4,
    intervalMs: 60_000,
    sleep: async (ms) => void waits.push(ms),
  });
  assert.equal(result.status, "failed");
  assert.equal(result.filledAmount, "200");
  assert.deepEqual(waits, [60_000, 60_000]);

  amounts.length = 0;
  const skipped = await runTwap(client, {
    market: "ETH",
    side: "sell",
    totalAmount: "400",
    slices: 4,
    intervalMs: 1_000,
    onError: "skip",
    sleep: async () => {},
  });
  assert.equal(skipped.status, "complete");
  assert.equal(skipped.filledAmount, "300");
  assert.equal(skipped.failures.length, 1);

  const controller = new AbortController();
  controller.abort();
  const aborted = await runTwap(client, {
    market: "ETH",
    side: "sell",
    totalAmount: "400",
    slices: 4,
    intervalMs: 1_000,
    signal: controller.signal,
  });
  assert.equal(aborted.status, "aborted");
  assert.equal(aborted.fills.length, 0);
});

test("trailing stop only moves in the position's favour and by at least the step", () => {
  assert.equal(trailingStopPrice("long", 100_000n, 500), 95_000n);
  assert.equal(trailingStopPrice("short", 100_000n, 500), 105_000n);
  const long = new TrailingStop("long", 500, 10);
  assert.equal(long.update(100_000_000n), 95_000_000n);
  assert.equal(long.update(99_000_000n), undefined);
  // 0.05% better is under the 10 bps step.
  assert.equal(long.update(100_050_000n), undefined);
  assert.equal(long.update(101_000_000n), 95_950_000n);
  const short = new TrailingStop("short", 100, 0);
  assert.equal(short.update(2_000_000_000n), 2_020_000_000n);
  assert.equal(short.update(2_100_000_000n), undefined);
  assert.equal(short.update(1_900_000_000n), 1_919_000_000n);
});

test("trailing stop places the new stop before cancelling the old one", async () => {
  const log: string[] = [];
  let feed: (mid: bigint) => void = () => {};
  let next = 0;
  const client = {
    triggerOrder: async (input: { triggerPrice: string; kind: string; sizing: string }) => {
      assert.equal(input.kind, "stop-loss");
      assert.equal(input.sizing, "position");
      log.push(`place ${input.triggerPrice}`);
      return { orderId: `stop-${++next}` };
    },
    cancelOrder: async (orderId: string) => void log.push(`cancel ${orderId}`),
  } as unknown as RfqClient;
  const runner = runTrailingStop(client, {
    market: "BTC",
    position: "long",
    trailBps: 200,
    subscribe: (onMid) => {
      feed = onMid;
      return () => {
        feed = () => {};
      };
    },
  });
  feed(100_000_000_000n);
  await runner.settled();
  feed(102_000_000_000n);
  await runner.settled();
  assert.deepEqual(log, ["place 98000", "place 99960", "cancel stop-1"]);
  assert.equal(runner.orderId(), "stop-2");
  runner.stop();
  feed(110_000_000_000n);
  await runner.settled();
  assert.equal(log.length, 3);
});
