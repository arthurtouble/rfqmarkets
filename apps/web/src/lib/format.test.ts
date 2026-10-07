import assert from "node:assert/strict";
import { test } from "node:test";
import { bpsLeverage, dateTime, fundingApr, microToInput, parseUsdcInput, signedUsdc, usdc } from "./format.js";

test("parses user-typed USDC amounts exactly", () => {
  assert.equal(parseUsdcInput("1000"), 1_000_000_000n);
  assert.equal(parseUsdcInput("0.000001"), 1n);
  assert.equal(parseUsdcInput("1,250.5"), 1_250_500_000n);
  assert.equal(parseUsdcInput("12."), 12_000_000n);
  for (const invalid of ["", "0", "0.0", "-1", "1e3", "abc", "1.0000001", "."]) assert.equal(parseUsdcInput(invalid), null, invalid);
});

test("round-trips integer USDC to input strings", () => {
  assert.equal(microToInput(1_000_000_000n), "1000");
  assert.equal(microToInput(1_250_500_000n), "1250.5");
  assert.equal(microToInput(1n), "0.000001");
  for (const value of ["25", "0.01", "99999.123456"]) assert.equal(microToInput(parseUsdcInput(value)!), value);
});

test("formats money and rates", () => {
  assert.equal(usdc("1234567"), "$1.23");
  assert.equal(usdc(undefined), "—");
  assert.equal(signedUsdc("5000000"), "+$5.00");
  assert.equal(signedUsdc("-5000000"), "-$5.00");
  // Amounts that round to zero carry no sign.
  assert.equal(signedUsdc("-5"), "$0.00");
  assert.equal(signedUsdc("4999"), "$0.00");
  assert.equal(signedUsdc("5000"), "+$0.01");
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
  const thisYear = dateTime(new Date(2026, 0, 3, 9, 5).getTime(), now), lastYear = dateTime(new Date(2025, 0, 3, 9, 5).getTime(), now);
  assert.match(thisYear, /3/);
  assert.doesNotMatch(thisYear, /2026/);
  assert.match(lastYear, /2025/);
});
