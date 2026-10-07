// Renders the dashboard's panels for each state an operator can see, without a browser.
import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { App, HealthPill, MarketCard, Orders } from "./App.js";
import type { HedgeOrder } from "./model.js";

const E18 = 10n ** 18n;
const text = (element: React.ReactElement) => renderToStaticMarkup(element).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

test("first paint shows loading placeholders and a connecting status, never Unavailable", () => {
  const html = renderToStaticMarkup(<App />);
  assert.match(html, /Connecting/);
  assert.doesNotMatch(html, /Unavailable/);
  assert.match(html, /aria-busy="true"/);
  assert.match(html, /cannot place, cancel or change anything/);
});

test("health pill tones", () => {
  assert.match(renderToStaticMarkup(<HealthPill health={{ tone: "ok", label: "Live" }} />), /rfq-badge--long[^>]*>.*Live/);
  assert.match(renderToStaticMarkup(<HealthPill health={{ tone: "bad", label: "Degraded", detail: "x" }} />), /rfq-badge--short/);
});

test("a market outside its band shows why trading is restricted", () => {
  const html = text(
    <MarketCard
      market={{
        symbol: "BTC",
        risk: { longBase: String(E18), shortBase: "0", netBase: String(E18), longAccounts: 1, shortAccounts: 0 },
        hedge: {
          customerBase: String(E18),
          venueBase: "0",
          gapBase: String(E18),
          gapNotional: "60000000000",
          bandUsdc: "25000000000",
          coin: "BTC",
          state: "hedge_required",
          tradingMode: "reduce_only",
          executionError: "book too thin",
        },
        longShare: 100,
        bandUse: 240,
      }}
    />,
  );
  for (const expected of ["Reduce-only", "Hedge required", "1 account ", "+1 BTC", "$60,000 of $25,000 band", "book too thin"])
    assert.ok(html.includes(expected), `${expected} in ${html}`);
});

test("a market with no hedge venue and no exposure", () => {
  const html = renderToStaticMarkup(
    <MarketCard
      market={{
        symbol: "SOL",
        hedge: {
          customerBase: "0",
          venueBase: "0",
          gapBase: "0",
          gapNotional: "0",
          bandUsdc: "25000000000",
          coin: null,
          state: "unhedged",
        },
        bandUse: 0,
      }}
    />,
  );
  assert.match(html, /No hedge venue/);
  assert.match(html, /No open customer exposure/);
  assert.match(html, /ops-coin/, "unknown markets get the generic coin mark");
});

test("orders: loading, failed, empty and a journal with every status", () => {
  assert.match(renderToStaticMarkup(<Orders />), /aria-busy/);
  assert.match(text(<Orders failed />), /appear once the hedger answers/);
  assert.match(text(<Orders orders={[]} />), /No hedge orders yet/);
  const order = (status: string, delta: bigint, reason?: string): HedgeOrder => ({
    client_id: `0x${status.padEnd(64, "0")}`,
    market: "BTC",
    target_block: 12,
    base_delta: String(delta),
    limit_price: "120000000000",
    status,
    filled_base: status === "filled" ? String(delta) : "0",
    reason,
    created_ms: 1,
  });
  const html = text(<Orders orders={[order("filled", E18 / 4n), order("rejected", -E18, "margin"), order("open", E18)]} />);
  for (const expected of ["Filled", "Rejected", "Open", "Long", "Short", "0.25", "$120,000.00", "margin"])
    assert.ok(html.includes(expected), expected);
});
