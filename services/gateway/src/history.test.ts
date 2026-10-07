import assert from "node:assert/strict";
import { test } from "node:test";
import { MarketHistory } from "./history.js";

const frame = (time: number, btc: string, eth = btc) =>
  JSON.stringify({
    markets: {
      BTC: { observedAtMs: time, mid: btc, bid: btc, ask: btc },
      ETH: { observedAtMs: time, mid: eth, bid: eth, ask: eth },
    },
  });
test("market history samples and bounds disposable chart context", () => {
  const history = new MarketHistory(3, 1_000);
  history.record(frame(1_000, "100"));
  history.record(frame(1_500, "101"));
  history.record(frame(2_000, "102"));
  history.record(frame(3_000, "103"));
  history.record(frame(4_000, "104"));
  assert.deepEqual(
    history.get("BTC", 20).map((point) => point.mid),
    ["102", "103", "104"],
  );
  assert.equal(history.status().points.ETH, 3);
});
test("market history ignores malformed frames without poisoning later data", () => {
  const history = new MarketHistory(5, 0);
  history.record("not-json");
  history.record(JSON.stringify({ markets: { BTC: { observedAtMs: -1, mid: "x", bid: "1", ask: "1" } } }));
  history.record(frame(10, "99"));
  assert.deepEqual(history.get("BTC"), [{ observedAtMs: 10, mid: "99", bid: "99", ask: "99" }]);
  assert.deepEqual(history.get("ETH", 2), [{ observedAtMs: 10, mid: "99", bid: "99", ask: "99" }]);
});
