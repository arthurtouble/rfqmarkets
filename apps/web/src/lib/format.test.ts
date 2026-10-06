import assert from "node:assert/strict";
import { test } from "node:test";
import { fundingApr, microToInput, parseUsdcInput, signedUsdc, usdc } from "./format.js";

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
  assert.equal(fundingApr("100000000000"), "10.00%");
});
