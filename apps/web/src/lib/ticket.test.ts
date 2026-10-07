import assert from "node:assert/strict";
import { test } from "node:test";
import { emptyAccount, initialMarginAfter, markAccount } from "./account.js";
import { maxLeverageAt } from "./leverage.js";
import {
  isDecimalDraft, leverageCeiling, leverageLabel, limitMarketable, MARGIN_PROBLEM, maxNotionalAt, maxPay, parseTicketMemory,
  positionNotional, presetPay, quoteSecondsLeft, quoteUsable, reducesPosition, submitLabel, ticketProblem, type TicketCheck,
} from "./ticket.js";
import type { MarketSnapshot, MarketState } from "./types.js";

const USDC = 1_000_000n, BASE = 10n ** 18n;
/** 20x at the first tier, as BTC and ETH on the dev deployment. */
const SCALE = 2_500;

const market = (name: string, bid: bigint, ask: bigint): MarketState => ({
  market: name, bid: bid.toString(), ask: ask.toString(), mid: ((bid + ask) / 2n).toString(), observedAtMs: 0, source: "test",
  volatilityBps: 0, baseSpreadBps: 2, fundingApr: "0", fundingIndex: "0", projectedFundingIndex: "0", enabled: true,
  maxTradeNotional: "0", maxMarketNotional: "0", operatingMaxTradeNotional: "0", riskMode: "normal", canBuy: true, canSell: true,
  marginScaleBps: SCALE, maxLeverage: 20,
});
const snapshot: MarketSnapshot = {
  blockNumber: 1, serverTimeMs: 0,
  markets: { BTC: market("BTC", 99_990n * USDC, 100_010n * USDC), ETH: market("ETH", 3_999n * USDC, 4_001n * USDC) },
  pricing: { settled: { BTC: "0", ETH: "0" }, pending: [], baseSpreadBps: 2, feeBps: 2, toleranceBps: 8 },
};

const ready: TicketCheck = {
  side: "buy", priceLive: true, enabled: true, reduces: false, sideOpen: true, amountText: "100", payMicro: 100n * USDC,
  notionalMicro: 500n * USDC, tradeCapMicro: 25_000n * USDC, leverage: 5, leverageCeiling: 20, isLimit: false, limitMicro: null,
  quoteError: null, hasQuote: true, marginShort: false,
};

test("the position is what you pay times leverage", () => {
  assert.equal(positionNotional(250n * USDC, 5), 1_250n * USDC);
  assert.equal(positionNotional(10n * USDC, 20), 200n * USDC);
  assert.equal(positionNotional(10n * USDC, 2.5), 25n * USDC);
});

test("the leverage ceiling falls once the position leaves the first margin tier", () => {
  // 20x on $1,000 is $20,000: first tier.
  assert.equal(leverageCeiling(1_000n * USDC, 20, SCALE), 20);
  // 20x on $2,000 is $40,000: second tier (25% x 0.25 = 6.25%) allows 16x.
  assert.equal(leverageCeiling(2_000n * USDC, 20, SCALE), 16);
  // A market whose max is 5x never offers more than 5x.
  assert.equal(leverageCeiling(10n * USDC, 5, 10_000), 5);
  assert.equal(leverageCeiling(10n * USDC, 0, SCALE), 0);
});

test("the largest position a leverage allows follows the tiers", () => {
  assert.equal(maxNotionalAt(20, SCALE), 25_000n * USDC);
  assert.equal(maxNotionalAt(16, SCALE), 100_000n * USDC);
  // The top tier at 0.25 scale is 25%: 5x stops at $2.5M, 4x is allowed at any size.
  assert.equal(maxNotionalAt(5, SCALE), 2_500_000n * USDC);
  assert.equal(maxNotionalAt(4, SCALE), null);
  // 5x at 1x scale is the first tier only; 21x at 0.25 scale is never allowed.
  assert.equal(maxNotionalAt(5, 10_000), 25_000n * USDC);
  assert.equal(maxNotionalAt(21, SCALE), 0n);
});

test("max pay leaves room for the fee and respects the trade cap and tiers", () => {
  // Funds: pay + pay x 5 x 2bps <= 1,000.
  const funds = maxPay({ availableMicro: 1_000n * USDC, leverage: 5, feeBps: 2, tradeCapMicro: 1_000_000n * USDC, scaleBps: SCALE });
  assert.equal(funds, 999_000_000n);
  assert.ok(funds + positionNotional(funds, 5) * 2n / 10_000n <= 1_000n * USDC);
  // Cap: $25 per trade at 5x is $5 to pay, as on the mainnet dev deployment.
  assert.equal(maxPay({ availableMicro: 1_000n * USDC, leverage: 5, feeBps: 2, tradeCapMicro: 25n * USDC, scaleBps: SCALE }), 5n * USDC);
  // Tiers: 20x stops at a $25,000 position, so $1,250 to pay.
  assert.equal(maxPay({ availableMicro: 1_000_000n * USDC, leverage: 20, feeBps: 2, tradeCapMicro: 1_000_000n * USDC, scaleBps: SCALE }), 1_250n * USDC);
  for (const available of [0n, -5n]) assert.equal(maxPay({ availableMicro: available, leverage: 5, feeBps: 2, tradeCapMicro: 0n, scaleBps: SCALE }), 0n);
  assert.equal(maxPay({ availableMicro: 100n * USDC, leverage: 0, feeBps: 2, tradeCapMicro: 0n, scaleBps: SCALE }), 0n);
});

test("paying max pay at any preset leverage stays within initial margin", () => {
  for (const collateral of [10n, 100n, 1_000n, 50_000n]) {
    const state = markAccount({ ...emptyAccount("0xabc", snapshot), collateral: (collateral * USDC).toString() }, snapshot);
    for (const leverage of [2, 5, 10, 20]) {
      const pay = maxPay({ availableMicro: BigInt(state.availableMargin), leverage, feeBps: 2, tradeCapMicro: 10_000_000n * USDC, scaleBps: SCALE });
      const notional = positionNotional(pay, leverage);
      assert.ok(leverage <= maxLeverageAt(notional, SCALE), `${leverage}x within the tier at ${notional}`);
      const fee = notional * 2n / 10_000n;
      assert.ok(initialMarginAfter(state, snapshot, "BTC", notional) + fee <= BigInt(state.openingEquity), `${collateral} USDC at ${leverage}x`);
    }
  }
});

test("presets are a share of the max, in whole cents", () => {
  assert.equal(presetPay(999_999_999n, 25), 249_990_000n);
  assert.equal(presetPay(10n * USDC, 100), 10n * USDC);
  assert.equal(presetPay(0n, 50), 0n);
});

test("the ticket names the first thing to fix", () => {
  assert.equal(ticketProblem(ready), null);
  assert.equal(ticketProblem({ ...ready, enabled: false }), "Paused · closing only");
  assert.equal(ticketProblem({ ...ready, enabled: false, reduces: true }), null);
  assert.equal(ticketProblem({ ...ready, sideOpen: false }), "Long is closed right now");
  assert.equal(ticketProblem({ ...ready, side: "sell", sideOpen: false }), "Short is closed right now");
  assert.equal(ticketProblem({ ...ready, priceLive: false }), "Waiting for a fresh price");
  assert.equal(ticketProblem({ ...ready, amountText: "", payMicro: null }), "Enter an amount");
  assert.equal(ticketProblem({ ...ready, amountText: "0", payMicro: null }), "Enter a valid amount");
  assert.equal(ticketProblem({ ...ready, notionalMicro: 25_001n * USDC }), "Over the per-trade limit");
  assert.equal(ticketProblem({ ...ready, tradeCapMicro: 0n, notionalMicro: 10n ** 15n }), null);
  assert.equal(ticketProblem({ ...ready, leverage: 20, leverageCeiling: 16 }), "Up to 16× at this size");
  assert.equal(ticketProblem({ ...ready, isLimit: true }), "Enter a limit price");
  assert.equal(ticketProblem({ ...ready, isLimit: true, limitMicro: 90_000n * USDC }), null);
  assert.equal(ticketProblem({ ...ready, quoteError: "No price for BTC" }), "No price for BTC");
  assert.equal(ticketProblem({ ...ready, hasQuote: false }), "Waiting for a fresh price");
  assert.equal(ticketProblem({ ...ready, marginShort: true }), MARGIN_PROBLEM);
  // A paused market is reported before anything the trader typed.
  assert.equal(ticketProblem({ ...ready, enabled: false, amountText: "" }), "Paused · closing only");
});

test("labels say side, market, pay and leverage", () => {
  assert.equal(submitLabel({ side: "buy", market: "BTC", pay: "$250", leverage: 5, isLimit: false }), "Long BTC · $250 at 5×");
  assert.equal(submitLabel({ side: "sell", market: "ETH", pay: "$12.50", leverage: 2.5, isLimit: true }), "Limit short ETH · $12.50 at 2.5×");
  assert.equal(leverageLabel(20), "20×");
  assert.equal(leverageLabel(3.333), "3.33×");
});

test("a trade reduces only when it is opposite and no larger than the position", () => {
  const long = BASE / 100n, notional = 1_000n * USDC;
  assert.equal(reducesPosition(long, notional, -500n * USDC), true);
  assert.equal(reducesPosition(long, notional, -1_000n * USDC), true);
  assert.equal(reducesPosition(long, notional, -1_001n * USDC), false);
  assert.equal(reducesPosition(long, notional, 500n * USDC), false);
  assert.equal(reducesPosition(-long, notional, 500n * USDC), true);
  assert.equal(reducesPosition(0n, 0n, -1n), false);
  assert.equal(reducesPosition(long, notional, 0n), false);
});

test("a limit is marketable when the expected price is already at or better than it", () => {
  assert.equal(limitMarketable("buy", 100n, 101n), true);
  assert.equal(limitMarketable("buy", 101n, 100n), false);
  assert.equal(limitMarketable("sell", 101n, 100n), true);
  assert.equal(limitMarketable("sell", 100n, 100n), true);
});

test("firm quotes lapse before their deadline, leaving time to sign", () => {
  assert.equal(quoteUsable(10_000, 8_499), true);
  assert.equal(quoteUsable(10_000, 8_500), false);
  assert.equal(quoteSecondsLeft(31_500, 0), 30);
  assert.equal(quoteSecondsLeft(10_000, 9_000), 0);
});

test("remembered ticket inputs are validated", () => {
  assert.deepEqual(parseTicketMemory(JSON.stringify({ pay: "250", leverage: 5 })), { pay: "250", leverage: 5 });
  assert.deepEqual(parseTicketMemory(JSON.stringify({ pay: "1e9", leverage: -1 })), {});
  assert.deepEqual(parseTicketMemory(JSON.stringify({ pay: 5, leverage: "5" })), {});
  assert.deepEqual(parseTicketMemory("{not json"), {});
  assert.deepEqual(parseTicketMemory(null), {});
  assert.equal(isDecimalDraft("1."), true);
  assert.equal(isDecimalDraft(".5"), true);
  assert.equal(isDecimalDraft("1,000"), false);
});
