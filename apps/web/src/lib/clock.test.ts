import assert from "node:assert/strict";
import { test } from "node:test";
import { ClockSkew, RequoteBackoff, holdQuote, localDeadline } from "./clock.js";
import { quoteUsable } from "./ticket.js";

test("skew is the largest recent server-minus-local sample, so transit time doesn't count", () => {
  const clock = new ClockSkew(3);
  assert.equal(clock.skewMs, 0);
  assert.equal(clock.now(1_000), 1_000);
  // The device runs 9s fast: server stamps trail the local receive time by 9s plus the transit.
  clock.observe(100_000, 109_120);
  clock.observe(100_250, 109_300);
  assert.equal(clock.skewMs, -9_050);
  assert.equal(clock.now(110_000), 100_950);
  // Old samples age out, so a corrected device clock is picked up.
  clock.observe(200_000, 200_040);
  clock.observe(200_250, 200_300);
  clock.observe(200_500, 200_530);
  assert.equal(clock.skewMs, -30);
});

test("snapshots without a server time are ignored", () => {
  const clock = new ClockSkew();
  clock.observe(undefined, 5_000);
  clock.observe(Number.NaN, 5_000);
  clock.observe(0, 5_000);
  assert.equal(clock.skewMs, 0);
});

test("a held quote is judged by its arrival plus its time to live, whatever the device clock says", () => {
  const fast = new ClockSkew();
  fast.observe(1_000_000, 1_009_000); // device 9s fast
  // The server issued the quote at 1_000_000 with 10s to live; it arrives at local 1_009_000.
  const held = holdQuote({ expiresAtMs: 1_010_000 }, 1_009_000, fast);
  assert.equal(held.localDeadlineMs, 1_019_000);
  assert.equal(localDeadline(held), 1_019_000);
  assert.ok(quoteUsable(held.localDeadlineMs, 1_015_000));
  assert.ok(!quoteUsable(held.localDeadlineMs, 1_018_000));
  // Judged naively against the device clock it would already have lapsed, and re-quoting would loop.
  assert.ok(!quoteUsable(held.expiresAtMs, 1_009_000));
  // A quote that was never held moves onto the local clock by the skew.
  assert.equal(localDeadline({ expiresAtMs: 1_010_000 }, fast), 1_019_000);
});

test("automatic re-quotes are spaced out, back off on failures and give up", () => {
  const backoff = new RequoteBackoff(2_000, 15_000, 3);
  assert.equal(backoff.delay(0), 0);
  backoff.sent(1_000);
  assert.equal(backoff.delay(1_500), 1_500);
  backoff.failed();
  assert.equal(backoff.delay(1_000), 4_000);
  backoff.sent(5_000);
  backoff.failed();
  assert.equal(backoff.delay(5_000), 8_000);
  backoff.sent(13_000);
  backoff.failed();
  assert.equal(backoff.exhausted, true);
  assert.equal(backoff.delay(100_000), null);
  backoff.reset();
  assert.equal(backoff.delay(13_000), 0);
  backoff.sent(13_000);
  backoff.failed();
  backoff.succeeded();
  assert.equal(backoff.delay(14_000), 1_000);
});
