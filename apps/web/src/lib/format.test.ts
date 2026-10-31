import assert from "node:assert/strict";
import { test } from "node:test";
import {
  bpsLeverage,
  dateTime,
  feeLabel,
  fundingApr,
  microToInput,
  parseUsdcInput,
  priceDecimals,
  signedUsdc,
  usdc,
  usdPrice,
  usdPriceNumber,
} from "./format.js";

test("parses user-typed USDC amounts exactly", () => {
  assert.equal(parseUsdcInput("1000"), 1_000_000_000n);
  assert.equal(parseUsdcInput("0.000001"), 1n);
  assert.equal(parseUsdcInput("1,250.5"), 1_250_500_000n);
  assert.equal(parseUsdcInput("12."), 12_000_000n);
  for (const invalid of ["", "0", "0.0", "-1", "1e3", "abc", "1.0000001", "."])
    assert.equal(parseUsdcInput(invalid), null, invalid);
});

test("round-trips integer USDC to input strings", () => {
  assert.equal(microToInput(1_000_000_000n), "1000");
  assert.equal(microToInput(1_250_500_000n), "1250.5");
  assert.equal(microToInput(1n), "0.000001");
  for (const value of ["25", "0.01", "99999.123456"])
    assert.equal(microToInput(parseUsdcInput(value)!), value);
});

test("formats money and rates", () => {
  assert.equal(usdc("1234567"), "$1.23");
  assert.equal(usdc(undefined), "—");
  assert.equal(signedUsdc("5000000"), "+$5.00");
  assert.equal(signedUsdc("-5000000"), "-$5.00");
  // Amounts that round to zero carry no sign.
  assert.equal(signedUsdc("-5"), "$0.00");
  assert.equal(signedUsdc("99"), "$0.00");
  assert.equal(signedUsdc("2500"), "+$0.0025");
  assert.equal(signedUsdc("-2500"), "-$0.0025");
  assert.equal(signedUsdc("5000"), "+$0.005");
  assert.equal(fundingApr("100000000000"), "10.00%");
});

test("formats leverage, with tiny leverage shown as under 0.01x", () => {
  assert.equal(bpsLeverage(null), "—");
  assert.equal(bpsLeverage("0"), "0.00×");
  assert.equal(bpsLeverage("40"), "<0.01×");
  assert.equal(bpsLeverage("25000"), "2.50×");
});

test("history times carry the date, and the year only when it differs", () => {
  const now = new Date(2026, 9, 7, 12).getTime();
  const thisYear = dateTime(new Date(2026, 0, 3, 9, 5).getTime(), now),
    lastYear = dateTime(new Date(2025, 0, 3, 9, 5).getTime(), now);
  assert.match(thisYear, /3/);
  assert.doesNotMatch(thisYear, /2026/);
  assert.match(lastYear, /2025/);
});

test("a zero fee reads as none", () => {
  assert.equal(feeLabel("0"), "None");
  assert.equal(feeLabel(20_000n), "$0.02");
  assert.equal(feeLabel(undefined), "—");
});

test("prices keep about five significant digits below $10 and cents above", () => {
  assert.equal(usdPrice(97_412_500_000n), "$97,412.50");
  assert.equal(usdPrice("12345678"), "$12.35");
  assert.equal(usdPrice(3_456_700n), "$3.4567");
  assert.equal(usdPrice(123_456n), "$0.12346");
  assert.equal(usdPrice(1_234n), "$0.001234");
  // PEPE-like prices sit at the wire's 1e6 precision rather than reading $0.00.
  assert.equal(usdPrice(12n), "$0.000012");
  assert.equal(usdPrice(0n), "$0.00");
  assert.equal(usdPrice(null), "—");
  assert.equal(priceDecimals(9.99), 4);
  assert.equal(priceDecimals(10), 2);
  // A set of prices (an axis, a change) can share the precision of its level.
  assert.equal(usdPriceNumber(0.000123, priceDecimals(0.1234), true), "+$0.00012");
  assert.equal(usdPriceNumber(-12.5, 2, true), "-$12.50");
  // Money amounts keep cents.
  assert.equal(usdc(123_456n), "$0.12");
});
