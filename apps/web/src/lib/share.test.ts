import assert from "node:assert/strict";
import { test } from "node:test";
import {
  betLabel,
  placeLine,
  returnLabel,
  shareCaption,
  shareFileName,
  shareHeadline,
  shareMood,
  shareSubline,
  type ShareBet,
} from "./share.js";

const USDC = 1_000_000n;
const bet = (over: Partial<ShareBet> = {}): ShareBet => ({
  market: "ETH",
  name: "Ethereum",
  long: true,
  multiplier: 3,
  pnl: 1240n * 10_000n,
  ret: 0.496,
  entryPrice: 2_500n * USDC,
  price: 2_541n * USDC,
  closed: true,
  ...over,
});

test("returns read with one decimal, none past 1000%, and no sign at zero", () => {
  assert.equal(returnLabel(0.496), "+49.6%");
  assert.equal(returnLabel(-0.0821), "-8.2%");
  assert.equal(returnLabel(12.345), "+1235%");
  assert.equal(returnLabel(0.0001), "0.0%");
  assert.equal(returnLabel(-0.0004), "0.0%");
  assert.equal(returnLabel(null), null);
  assert.equal(returnLabel(Number.NaN), null);
});

test("the card leads with the return and falls back to dollars without a stake", () => {
  assert.equal(shareHeadline(bet()), "+49.6%");
  assert.equal(shareSubline(bet()), "+$12.40");
  assert.equal(shareHeadline(bet({ ret: null })), "+$12.40");
  assert.equal(shareSubline(bet({ ret: null })), null);
});

test("Tick cheers a gain, sweats a loss and stays calm at break-even", () => {
  assert.equal(shareMood(bet()), "win");
  assert.equal(shareMood(bet({ pnl: -1n })), "loss");
  assert.equal(shareMood(bet({ pnl: 0n })), "idle");
});

test("captions say what the bet was and whether it is still open", () => {
  assert.equal(shareCaption(bet()), "Cashed out +$12.40 (+49.6%) going Up 3× on Ethereum.");
  assert.equal(
    shareCaption(bet({ closed: false, long: false, multiplier: null, pnl: -5n * USDC, ret: null })),
    "Down on Ethereum: -$5.00 so far.",
  );
  assert.equal(betLabel({ long: false, multiplier: 10 }), "Down 10×");
});

test("file names are safe for any market symbol", () => {
  assert.equal(shareFileName({ market: "BTC", long: true }), "rfq-btc-up.png");
  assert.equal(shareFileName({ market: "kPEPE/USD", long: false }), "rfq-kpepe-usd-down.png");
});

test("the line spans the box, keeps the entry in view and centres a flat line", () => {
  const points = [
    { time: 0, value: 100 },
    { time: 50, value: 110 },
    { time: 100, value: 105 },
  ];
  const { xy, y } = placeLine(points, 200, 100, [90], 0);
  assert.deepEqual(
    xy.map(([x]) => x),
    [0, 100, 200],
  );
  assert.equal(y(110), 0);
  assert.equal(y(90), 100);

  const flat = placeLine(
    [
      { time: 0, value: 5 },
      { time: 1, value: 5 },
    ],
    200,
    100,
  );
  assert.ok(Math.abs(flat.xy[0][1] - 50) < 1e-9);
  assert.equal(placeLine([{ time: 7, value: 5 }], 200, 100).xy[0][0], 100);
});
