// Renders the market controls' panels without a browser or chain.
import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MarketControls, MarketTable, Runner } from "./MarketControls.js";
import { planChanges, type ChainMarket, type ConsoleState } from "./controls-model.js";

const USDC = 1_000_000n;
const text = (element: React.ReactElement) =>
  renderToStaticMarkup(element)
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ");
const market = (symbol: string, index: number, changes: Partial<ChainMarket> = {}): ChainMarket => ({
  index,
  symbol,
  enabled: true,
  maxTradeNotional: 100_000n * USDC,
  maxMarketNotional: 1_000_000n * USDC,
  grossLimit: 2_000_000n * USDC,
  sideLimit: 1_000_000n * USDC,
  impactK: 10_000,
  shockBps: 4_000,
  marginScaleBps: 2_500,
  spreadBps: 0,
  ...changes,
});
const state: ConsoleState = {
  markets: [
    market("BTC", 0, { spreadBps: 6 }),
    market("kPEPE", 1, { enabled: false, marginScaleBps: 20_000 }),
  ],
  bounds: {
    maxTradeNotional: 250_000n * USDC,
    maxMarketNotional: 2_000_000n * USDC,
    maxGrossLimit: 3_000_000n * USDC,
    minImpactK: 5_000,
    minShockBps: 2_000,
    minMarginScaleBps: 5_000,
  },
  defaultSpreadBps: 3,
  governance: "0x00000000000000000000000000000000000000aa",
  riskOperator: "0x00000000000000000000000000000000000000bb",
  emergencyCouncil: "0x00000000000000000000000000000000000000cc",
  paused: false,
  legacy: false,
};
const noop = () => {};

test("first paint asks for the venue config, with no controls until a wallet connects", () => {
  const html = text(<MarketControls />);
  assert.match(html, /Markets and risk/);
  assert.match(html, /Not connected/);
  assert.doesNotMatch(html, /List a market/);
});

test("every market shows its status, caps, leverage and effective spread", () => {
  const html = text(<MarketTable state={state} canEdit={false} onEdit={noop} onToggle={noop} />);
  assert.match(html, /BTC #0 Open/);
  assert.match(html, /kPEPE #1 Reduce-only/);
  assert.match(html, /Max trade \$100,000/);
  assert.match(html, /Max leverage 20x/);
  assert.match(html, /Max leverage 2\.5x/);
  assert.match(html, /Base spread 6 bps/);
  assert.match(html, /Base spread 3 bps default/);
  assert.doesNotMatch(html, /Edit|Make reduce-only/);
  const editable = text(<MarketTable state={state} canEdit onEdit={noop} onToggle={noop} />);
  assert.match(editable, /Make reduce-only Edit/);
  assert.match(editable, /Reopen Edit/);
  assert.match(
    text(
      <MarketTable
        waiting="Connect a wallet to load the markets."
        canEdit={false}
        onEdit={noop}
        onToggle={noop}
      />,
    ),
    /Connect a wallet/,
  );
});

test("review lists every change and refuses to sign what the role may not do", () => {
  const btc = state.markets[0];
  const allowed = planChanges(
    btc,
    { ...btc, enabled: false, shockBps: 5_000 },
    "risk_operator",
    state.bounds,
    3,
  );
  const html = text(<Runner calls={allowed} onDone={noop} />);
  assert.match(html, /Trading and trade limits/);
  assert.match(html, /Trading Open → Reduce-only/);
  assert.match(html, /Stress shock 40% → 50%/);
  assert.match(html, /Transaction 1 of 2/);
  assert.match(html, /Sign 2 transactions/);
  const blocked = planChanges(
    btc,
    { ...btc, maxTradeNotional: 500_000n * USDC },
    "risk_operator",
    state.bounds,
    3,
  );
  const refused = text(<Runner calls={blocked} onDone={noop} />);
  assert.match(refused, /max trade ceiling of \$250,000/);
  assert.match(refused, /Not allowed for this wallet/);
});
