import assert from "node:assert/strict";
import { test } from "node:test";
import { bucketPoints, positionTransition, replayPortfolio, type PortfolioEvent } from "./portfolio.js";

const E = 10n ** 18n,
  usdc = (value: number) => BigInt(value) * 1_000_000n;
let sequence = 0;
const event = (
  block: number,
  kind: string,
  payload: Record<string, string>,
  extra: Partial<PortfolioEvent> = {},
): PortfolioEvent => ({
  txHash: `0x${block.toString(16).padStart(64, "0")}`,
  logIndex: sequence++,
  blockNumber: block,
  timestamp: block * 600,
  kind,
  payload,
  ...extra,
});
const trade = (block: number, market: string, delta: bigint, price: bigint, fee: bigint) =>
  event(block, "TradeExecuted", {
    market,
    baseDelta: delta.toString(),
    price: price.toString(),
    fee: fee.toString(),
  });

test("positionTransition mirrors RFQRiskMath for adds, reductions and flips", () => {
  assert.deepEqual(positionTransition(0n, 0n, E, usdc(100)), {
    nextSize: E,
    nextEntry: usdc(100),
    realizedPnl: 0n,
  });
  assert.deepEqual(positionTransition(E, usdc(100), E, usdc(200)), {
    nextSize: 2n * E,
    nextEntry: usdc(150),
    realizedPnl: 0n,
  });
  assert.deepEqual(positionTransition(2n * E, usdc(150), -E, usdc(170)), {
    nextSize: E,
    nextEntry: usdc(150),
    realizedPnl: usdc(20),
  });
  // Flip: closes 1 long at a loss, opens 1 short at the fill price.
  assert.deepEqual(positionTransition(E, usdc(150), -2n * E, usdc(140)), {
    nextSize: -E,
    nextEntry: usdc(140),
    realizedPnl: -usdc(10),
  });
  assert.deepEqual(positionTransition(-E, usdc(140), E, usdc(130)), {
    nextSize: 0n,
    nextEntry: 0n,
    realizedPnl: usdc(10),
  });
  // Floors each leg separately, as the contract does.
  assert.equal(positionTransition(3n, 1n, -3n, 2n).realizedPnl, 0n);
});

test("replay reconciles trades, fees, funding, deposits and liquidations with collateral", () => {
  const events = [
    event(1, "Deposited", { amount: usdc(1_000).toString() }),
    trade(2, "0", 2n * E, usdc(100), usdc(1)),
    event(3, "FundingSettled", { market: "0", payment: usdc(2).toString() }),
    trade(3, "0", -E, usdc(110), usdc(1)),
    event(4, "FundingSettled", { market: "0", payment: (-usdc(1)).toString() }),
    trade(5, "1", -E / 2n, usdc(40), 0n),
    // Partial keeper close of the BTC long at the stored bid, then the penalty.
    event(
      6,
      "Liquidated",
      { market: "0", closedBase: (E / 2n).toString(), penalty: usdc(3).toString() },
      {
        liquidationMark: { bid: usdc(90), ask: usdc(91) },
      },
    ),
    // Full close of everything: PositionClosed for each leg in the same tx, then Liquidated.
    event(7, "PositionClosed", { market: "0", baseDelta: (-E / 2n).toString(), price: usdc(80).toString() }),
    event(7, "PositionClosed", { market: "1", baseDelta: (E / 2n).toString(), price: usdc(50).toString() }),
    event(7, "Liquidated", { market: "0", closedBase: (E / 2n).toString(), penalty: usdc(2).toString() }),
    event(7, "DeficitAbsorbed", { insuranceUsed: "5", makerUsed: "6", unresolved: "0" }),
    event(8, "Withdrawn", { amount: usdc(100).toString() }),
  ];
  const replay = replayPortfolio(events);
  // Realized: +10 (BTC 110 vs 100 on 1) - 5 (0.5 BTC at 90) - 10 (0.5 BTC at 80) - 5 (ETH short 40 -> 50 on 0.5).
  assert.equal(replay.totals.realizedPnl, -usdc(10));
  assert.equal(replay.totals.fees, usdc(2));
  assert.equal(replay.totals.funding, -usdc(1));
  assert.equal(replay.totals.liquidationPenalties, usdc(5));
  assert.equal(replay.totals.deficitCovered, 11n);
  assert.equal(replay.totals.tradeCount, 3);
  assert.equal(replay.totals.volume, usdc(200 + 110 + 20));
  assert.equal(replay.positions.BTC.size, 0n);
  assert.equal(replay.positions.ETH.size, 0n);
  assert.equal(replay.incomplete, false);
  assert.deepEqual(
    replay.fills.map((fill) => [fill.kind, fill.market, fill.realizedPnl, fill.cumulativeRealizedPnl]),
    [
      ["trade", "BTC", "0", "0"],
      ["trade", "BTC", usdc(10).toString(), usdc(10).toString()],
      ["trade", "ETH", "0", usdc(10).toString()],
      ["liquidation", "BTC", (-usdc(5)).toString(), usdc(5).toString()],
      ["close", "BTC", (-usdc(10)).toString(), (-usdc(5)).toString()],
      ["close", "ETH", (-usdc(5)).toString(), (-usdc(10)).toString()],
    ],
  );
  assert.deepEqual(
    replay.funding.map((item) => [item.payment, item.amount, item.cumulativeFunding]),
    [
      [usdc(2).toString(), (-usdc(2)).toString(), (-usdc(2)).toString()],
      [(-usdc(1)).toString(), usdc(1).toString(), (-usdc(1)).toString()],
    ],
  );
  // One point per block; the last one is the account's collateral.
  assert.deepEqual(
    replay.points.map((point) => point.blockNumber),
    [1, 2, 3, 4, 5, 6, 7, 8],
  );
  const last = replay.points.at(-1)!;
  assert.equal(last.netPnl, (-usdc(10) - usdc(2) - usdc(1) - usdc(5)).toString());
  assert.equal(last.netDeposits, usdc(900).toString());
  assert.equal(BigInt(last.collateral), usdc(900) - usdc(18) + 11n);
});

test("partial liquidation then portfolio close in one transaction closes each size once", () => {
  const events = [
    trade(1, "0", 2n * E, usdc(100), 0n),
    // Partial close of 0.5, then closePortfolio of the remaining 1.5 because collateral went negative.
    event(2, "PositionClosed", {
      market: "0",
      baseDelta: (-(3n * E) / 2n).toString(),
      price: usdc(70).toString(),
    }),
    event(
      2,
      "Liquidated",
      { market: "0", closedBase: (E / 2n).toString(), penalty: "0" },
      {
        liquidationMark: { bid: usdc(70), ask: usdc(71) },
      },
    ),
  ];
  const replay = replayPortfolio(events);
  assert.equal(replay.positions.BTC.size, 0n);
  assert.deepEqual(
    replay.fills.map((fill) => [fill.kind, fill.baseDelta]),
    [
      ["trade", (2n * E).toString()],
      ["liquidation", (-E / 2n).toString()],
      ["close", (-(3n * E) / 2n).toString()],
    ],
  );
  assert.equal(replay.totals.realizedPnl, -usdc(60));
});

test("a partial liquidation without a stored mark keeps sizes and flags the replay", () => {
  const replay = replayPortfolio([
    trade(1, "0", E, usdc(100), 0n),
    event(2, "Liquidated", { market: "0", closedBase: (E / 4n).toString(), penalty: "1" }),
  ]);
  assert.equal(replay.positions.BTC.size, (3n * E) / 4n);
  assert.equal(replay.totals.realizedPnl, 0n);
  assert.equal(replay.incomplete, true);
});

test("history buckets keep the last cumulative point per interval", () => {
  const replay = replayPortfolio([
    event(1, "Deposited", { amount: "10" }),
    event(2, "Deposited", { amount: "5" }),
    event(7, "Withdrawn", { amount: "1" }),
  ]);
  // Blocks are 600 s apart: blocks 1 and 2 share the first hour, block 7 (4200 s) is in the second.
  const hourly = bucketPoints(replay.points, "1h");
  assert.deepEqual(
    hourly.map((point) => [point.timeMs, point.netDeposits]),
    [
      [0, "15"],
      [3_600_000, "14"],
    ],
  );
  assert.equal(bucketPoints(replay.points, "event").length, 3);
  assert.equal(bucketPoints(replay.points, "1d").length, 1);
});

test("margin moved to an isolated account counts toward net deposits on both sides", () => {
  const owner = replayPortfolio([
      event(1, "Deposited", { amount: "100" }),
      event(2, "MarginTransferred", { market: "0", amount: "-40" }),
    ]),
    isolated = replayPortfolio([event(2, "MarginTransferred", { market: "0", amount: "40" })]);
  assert.equal(owner.totals.transfers, -40n);
  assert.equal(owner.points.at(-1)?.netDeposits, "60");
  assert.equal(owner.points.at(-1)?.collateral, "60");
  assert.equal(isolated.points.at(-1)?.collateral, "40");
});
