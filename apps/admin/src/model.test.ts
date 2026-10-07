import assert from "node:assert/strict";
import test from "node:test";
import {
  attention,
  cleanError,
  duration,
  failureMessage,
  feedHealth,
  marketViews,
  totalGap,
  type HedgeStatus,
  type RiskSnapshot,
} from "./model.js";

const E18 = 10n ** 18n;
const market = (overrides: Partial<HedgeStatus["markets"][string]> = {}): HedgeStatus["markets"][string] => ({
  customerBase: "0",
  venueBase: "0",
  gapBase: "0",
  gapNotional: "0",
  bandUsdc: "25000000000",
  coin: "BTC",
  state: "within_band",
  tradingMode: "normal",
  ...overrides,
});
const status = (overrides: Partial<HedgeStatus> = {}): HedgeStatus => ({
  mode: "local-simulator",
  indexedBlock: 10,
  observedAtMs: 1_000_000,
  healthy: true,
  markets: { BTC: market(), ETH: market({ coin: "ETH" }) },
  orders: [],
  ...overrides,
});

test("feedHealth: connecting, live, stale, degraded, reconnecting and offline", () => {
  const now = 1_002_000;
  assert.deepEqual(feedHealth(undefined, { connected: false }, now), { tone: "idle", label: "Connecting" });
  assert.equal(feedHealth(undefined, { connected: false, error: "Hedger answered 503" }, now).label, "Offline");
  assert.deepEqual(feedHealth(status(), { connected: true }, now), { tone: "ok", label: "Live" });
  const stale = feedHealth(status({ observedAtMs: now - 12_000 }), { connected: true }, now);
  assert.equal(stale.label, "Stale");
  assert.match(stale.detail!, /12s ago/);
  const degraded = feedHealth(
    status({ healthy: false, error: "Error: indexer unavailable: Error: 503" }),
    { connected: true },
    now,
  );
  assert.deepEqual(degraded, { tone: "bad", label: "Degraded", detail: "Indexer unavailable: Error: 503" });
  assert.match(feedHealth(status({ healthy: false }), { connected: true }, now).detail!, /No exposure read for 2s/);
  assert.match(
    feedHealth(status({ healthy: false, observedAtMs: 0 }), { connected: true }, now).detail!,
    /first exposure read/,
  );
  const dropped = feedHealth(status(), { connected: false, error: "Hedger stream closed. Reconnecting." }, now);
  assert.equal(dropped.label, "Reconnecting");
});

test("failureMessage explains edge, runtime and auth failures", () => {
  assert.match(failureMessage("indexer", 403, '{"error":"edge_identity_missing"}'), /without a client IP/);
  assert.match(failureMessage("hedger", 401, '{"error":"unauthorized"}'), /refused the read \(401\)/);
  assert.equal(
    failureMessage("hedger", 503, '{"error":"runtime_unavailable","reason":"contracts_not_deployed"}'),
    "The dev runtime is not running (contracts_not_deployed).",
  );
  assert.match(failureMessage("hedger", 503, '{"error":"runtime_starting"}'), /starting/);
  assert.match(failureMessage("indexer", 429), /rate limiting/);
  assert.equal(failureMessage("indexer", 500, "<html>"), "Indexer answered 500. Retrying.");
});

test("cleanError drops error class prefixes", () => {
  assert.equal(cleanError("Error: hedge rejected: margin"), "Hedge rejected: margin");
  assert.equal(cleanError("TypeError: IndexerUnavailable: x"), "X");
  assert.equal(cleanError("Error: "), "Unknown error");
});

test("duration reads naturally", () => {
  assert.deepEqual([0, 59_400, 61_000, 3_600_000 + 120_000, 49 * 3_600_000].map(duration), ["0s", "59s", "1m", "1h 2m", "2d"]);
});

test("marketViews merges both feeds, keeps the chain's market order and adds markets only one feed knows", () => {
  const risk: RiskSnapshot = {
    indexedBlock: 9,
    accountCount: 2,
    totalCollateral: "1",
    markets: {
      ETH: { longBase: "0", shortBase: "0", netBase: "0", longAccounts: 0, shortAccounts: 0 },
      BTC: { longBase: String(3n * E18), shortBase: String(E18), netBase: String(2n * E18), longAccounts: 2, shortAccounts: 1 },
      SOL: { longBase: String(E18), shortBase: "0", netBase: String(E18), longAccounts: 1, shortAccounts: 0 },
    },
  };
  const views = marketViews(risk, status({ markets: { BTC: market({ gapNotional: "30000000000" }), ETH: market() } }));
  assert.deepEqual(views.map((view) => view.symbol), ["BTC", "ETH", "SOL"]);
  assert.equal(views[0].longShare, 75);
  assert.equal(views[0].bandUse, 120);
  assert.equal(views[1].longShare, undefined, "no exposure has no split");
  assert.equal(views[2].hedge, undefined);
  assert.deepEqual(marketViews(undefined, undefined), []);
});

test("totals and attention counts", () => {
  const hedge = status({
    markets: {
      BTC: market({ gapNotional: "30000000000", state: "hedge_required", tradingMode: "guarded" }),
      ETH: market({ gapNotional: "5000000", coin: "ETH" }),
      SOL: market({ gapNotional: "1", coin: null, state: "unhedged", tradingMode: "reduce_only" }),
    },
  });
  assert.equal(totalGap(hedge), 30_005_000_001n);
  assert.deepEqual(attention(hedge), { hedgeRequired: 1, unhedged: 1, restricted: 2 });
  assert.deepEqual(attention(undefined), { hedgeRequired: 0, unhedged: 0, restricted: 0 });
});
