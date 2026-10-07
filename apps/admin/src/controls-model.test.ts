import assert from "node:assert/strict";
import test from "node:test";
import {
  leverageOf,
  listingDefaults,
  marginScaleFor,
  parseDraft,
  planChanges,
  planDefaultSpread,
  planListing,
  refusalMessage,
  roleOf,
  toDraft,
  type ChainMarket,
  type MarketSettings,
  type OperatorBounds,
} from "./controls-model.js";

const USDC = 1_000_000n;
const btc: ChainMarket = {
  index: 0,
  symbol: "BTC",
  enabled: true,
  maxTradeNotional: 100_000n * USDC,
  maxMarketNotional: 1_000_000n * USDC,
  grossLimit: 2_000_000n * USDC,
  sideLimit: 1_000_000n * USDC,
  impactK: 10_000,
  shockBps: 4_000,
  marginScaleBps: 10_000,
  spreadBps: 0,
};
const bounds: OperatorBounds = {
  maxTradeNotional: 250_000n * USDC,
  maxMarketNotional: 2_000_000n * USDC,
  maxGrossLimit: 3_000_000n * USDC,
  minImpactK: 5_000,
  minShockBps: 2_000,
  minMarginScaleBps: 5_000,
};
const roles = {
  governance: "0x00000000000000000000000000000000000000aa",
  riskOperator: "0x00000000000000000000000000000000000000Bb",
  emergencyCouncil: "0x00000000000000000000000000000000000000cc",
};

test("roles come from the contract's addresses, case-insensitively", () => {
  assert.equal(roleOf(roles, "0x00000000000000000000000000000000000000AA"), "governance");
  assert.equal(roleOf(roles, "0x00000000000000000000000000000000000000bb"), "risk_operator");
  assert.equal(roleOf(roles, roles.emergencyCouncil), "emergency");
  assert.equal(roleOf(roles, "0x00000000000000000000000000000000000000dd"), "none");
  assert.equal(
    roleOf(
      { ...roles, riskOperator: "0x0000000000000000000000000000000000000000" },
      "0x0000000000000000000000000000000000000000",
    ),
    "none",
  );
});

test("leverage and the margin multiplier convert both ways, never allowing more than asked", () => {
  assert.equal(leverageOf(2_500), 20);
  assert.equal(leverageOf(10_000), 5);
  assert.equal(marginScaleFor(20), 2_500);
  assert.equal(marginScaleFor(3), 16_667);
  assert(leverageOf(marginScaleFor(3)) <= 3);
});

test("a draft round-trips, and out-of-range values are explained per field", () => {
  const parsed = parseDraft(toDraft(btc));
  const { index: _index, symbol: _symbol, ...settings } = btc;
  assert.deepEqual(parsed.settings, settings);

  const errors = parseDraft({
    ...toDraft(btc),
    maxTrade: "2000000",
    side: "3000000",
    leverage: "25",
    shock: "3",
    impactK: "1.5",
    spread: "1",
  }).errors!;
  assert.deepEqual(Object.keys(errors).sort(), [
    "impactK",
    "leverage",
    "maxTrade",
    "shock",
    "side",
    "spread",
  ]);
  assert.match(errors.maxTrade!, /\$1,000,000/);
  assert.equal(
    parseDraft({ ...toDraft(btc), maxTrade: "2,000,000", maxNet: "1000000" }).errors?.maxTrade,
    "At most $1,000,000",
  );
  assert.equal(
    parseDraft({ ...toDraft(btc), maxTrade: "500000", maxNet: "100000" }).errors?.maxTrade,
    "Cannot exceed the net cap",
  );
  assert.equal(parseDraft({ ...toDraft(btc), spread: "" }).settings?.spreadBps, 0);
  assert.equal(
    parseDraft({ ...toDraft(btc), maxTrade: "$150,000" }).settings?.maxTradeNotional,
    150_000n * USDC,
  );
});

const edit = (changes: Partial<MarketSettings>) => ({ ...btc, ...changes });

test("each kind of change becomes its own call, in the contract's units", () => {
  const calls = planChanges(
    btc,
    edit({
      enabled: false,
      grossLimit: 1_000_000n * USDC,
      sideLimit: 500_000n * USDC,
      marginScaleBps: 2_500,
      spreadBps: 8,
    }),
    "governance",
    bounds,
    0,
  );
  assert.deepEqual(
    calls.map((call) => [call.fn, call.args]),
    [
      ["setMarketPolicy", [0, false, 100_000n * USDC, 1_000_000n * USDC]],
      ["setExposurePolicy", [0, 1_000_000n * USDC, 500_000n * USDC]],
      ["setMarketRisk", [0, 10_000, 4_000, 2_500]],
      ["setSpread", [0, 8]],
    ],
  );
  assert(calls.every((call) => !call.blocked));
  assert.deepEqual(calls[2].changes[0], {
    label: "Max leverage",
    from: "5x",
    to: "20x",
    direction: "loosens",
  });
  assert.deepEqual(calls[3].changes[0], {
    label: "Base spread",
    from: "default (2 bps)",
    to: "8 bps",
    direction: "tightens",
  });
  assert.deepEqual(planChanges(btc, btc, "governance", bounds, 0), []);
});

test("the risk operator tightens freely and loosens only within its bounds", () => {
  const operator = (next: Partial<MarketSettings>) =>
    planChanges(btc, edit(next), "risk_operator", bounds, 0)[0];
  assert.equal(operator({ enabled: false }).blocked, undefined);
  assert.equal(operator({ maxTradeNotional: 250_000n * USDC }).blocked, undefined);
  assert.match(operator({ maxTradeNotional: 250_001n * USDC }).blocked!, /max trade ceiling of \$250,000/);
  assert.match(operator({ maxMarketNotional: 2_000_001n * USDC }).blocked!, /net cap ceiling/);
  assert.match(operator({ grossLimit: 3_000_001n * USDC }).blocked!, /gross cap ceiling/);
  assert.equal(operator({ marginScaleBps: 5_000 }).blocked, undefined);
  assert.match(operator({ marginScaleBps: 4_999 }).blocked!, /leverage ceiling of 10x/);
  assert.match(operator({ shockBps: 1_999 }).blocked!, /stress shock floor of 20%/);
  assert.match(operator({ impactK: 4_999 }).blocked!, /impact K floor of 5000/);
  assert.equal(operator({ spreadBps: 50 }).blocked, undefined);

  // Already above the ceiling: lowering is still allowed, raising is not.
  const wide = { ...btc, maxTradeNotional: 900_000n * USDC, maxMarketNotional: 4_000_000n * USDC };
  assert.equal(
    planChanges(wide, { ...wide, maxTradeNotional: 800_000n * USDC }, "risk_operator", bounds, 0)[0].blocked,
    undefined,
  );
  assert(
    planChanges(wide, { ...wide, maxTradeNotional: 950_000n * USDC }, "risk_operator", bounds, 0)[0].blocked,
  );
});

test("the emergency council may only make a market reduce-only and lower caps", () => {
  const emergency = (next: Partial<MarketSettings>) =>
    planChanges(btc, edit(next), "emergency", bounds, 0)[0];
  assert.equal(emergency({ enabled: false, maxTradeNotional: 10_000n * USDC }).blocked, undefined);
  assert.equal(emergency({ grossLimit: 1_000_000n * USDC, sideLimit: 400_000n * USDC }).blocked, undefined);
  assert(emergency({ maxTradeNotional: 200_000n * USDC }).blocked);
  assert(emergency({ shockBps: 6_000 }).blocked);
  assert(emergency({ spreadBps: 10 }).blocked);
  assert(planChanges({ ...btc, enabled: false }, btc, "emergency", bounds, 0)[0].blocked);
  assert.match(planChanges(btc, edit({ enabled: false }), "none", bounds, 0)[0].blocked!, /no market role/);
});

test("listing checks the symbol, the role and the operator's bounds", () => {
  const settings = listingDefaults(bounds, "risk_operator");
  assert.equal(settings.enabled, false);
  assert(settings.maxTradeNotional <= bounds.maxTradeNotional && settings.grossLimit <= bounds.maxGrossLimit);
  const listing = planListing("SOL", { ...settings, spreadBps: 6 }, "risk_operator", bounds, [btc]);
  assert.deepEqual(
    listing.calls.map((call) => [call.fn, call.blocked]),
    [
      ["addMarket", undefined],
      ["setSpread", undefined],
    ],
  );
  assert.deepEqual(listing.calls[1].args, [1, 6]);
  assert.equal((listing.calls[0].args[0] as { symbol: string }).symbol, "SOL");
  assert.equal(
    planListing("BTC", settings, "risk_operator", bounds, [btc]).errors?.symbol,
    "BTC is already listed",
  );
  assert.match(
    planListing("bad symbol", settings, "risk_operator", bounds, [btc]).errors!.symbol!,
    /Letters/,
  );
  assert.match(
    planListing("SOL", { ...settings, grossLimit: 4_000_000n * USDC }, "risk_operator", bounds, [btc])
      .calls[0].blocked!,
    /gross cap/,
  );
  assert.equal(
    planListing("SOL", { ...settings, grossLimit: 4_000_000n * USDC }, "governance", bounds, [btc]).calls[0]
      .blocked,
    undefined,
  );
  assert(planListing("SOL", settings, "emergency", bounds, [btc]).calls[0].blocked);
});

test("the default spread is market 255", () => {
  const call = planDefaultSpread(0, 5, "risk_operator");
  assert.deepEqual([call.fn, call.args, call.blocked], ["setSpread", [255, 5], undefined]);
  assert.deepEqual(call.changes[0], {
    label: "Default base spread",
    from: "2 bps",
    to: "5 bps",
    direction: "tightens",
  });
  assert(planDefaultSpread(0, 5, "emergency").blocked);
});

test("contract refusals read as plain words", () => {
  assert.match(refusalMessage({ revert: { name: "Unauthorized" } }), /role may not/);
  assert.match(
    refusalMessage(new Error('execution reverted: custom error "InvalidTrade()"')),
    /out of range/,
  );
  assert.equal(
    refusalMessage({ code: "ACTION_REJECTED", shortMessage: "user rejected action" }),
    "Cancelled in the wallet.",
  );
});
