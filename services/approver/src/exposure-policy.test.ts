import assert from "node:assert/strict";
import { test } from "node:test";
import { Wallet } from "ethers";
import { GrossReservationBook } from "../../../packages/shared/src/gross-reservations.js";
import { BASE, USDC } from "../../../packages/shared/src/numeric.js";
import { readChainState, type ChainSnapshot } from "./chain-state.js";
import {
  buildGrossContext,
  checkChainTimeExpiry,
  checkCrossMarketFreshness,
  checkExposure,
  checkImpact,
  checkMarketEnabled,
  checkTradeLimit,
  markedMarkets,
} from "./exposure-policy.js";
import { safetyPrices } from "./oracle-policy.js";
import type { OracleObservation } from "../../../packages/shared/src/oracle-report.js";
import { PRICES, buildFixture, chainState, fakeChain, word } from "./test-fixtures.js";

const error = (rejection: { body: { error: string } } | undefined) => rejection?.body.error;

async function setup(options: Parameters<typeof buildFixture>[0] = {}) {
  const fixture = buildFixture(options),
    state = chainState(fixture.nowMs),
    result = await readChainState(fakeChain(state), {
      chainId: fixture.domain.chainId,
      signer: Wallet.createRandom().address,
      intent: fixture.intent,
      intentHash: fixture.approval.intentHash,
      intentSigner: fixture.user.address,
      userSignature: fixture.payload.userSignature,
    });
  assert("snapshot" in result);
  const market = fixture.intent.market as 0 | 1,
    prices = safetyPrices(undefined, fixture.payload.quote),
    snapshot = result.snapshot,
    markets = markedMarkets(snapshot, market, prices, BigInt(snapshot.blockTimestamp));
  return { ...fixture, snapshot, market, prices, markets };
}

test("checkTradeLimit caps opening trades by the static ceiling and the market limit word", () => {
  const input = { positionSize: 0n, delta: 1n, notional: 10n, executionNotional: 10n, limitWord: word(10n) };
  assert.equal(checkTradeLimit(input), undefined);
  assert.equal(error(checkTradeLimit({ ...input, executionNotional: 11n })), "market trade limit exceeded");
  assert.equal(
    error(checkTradeLimit({ ...input, notional: 1_000_000n * USDC + 1n })),
    "market trade limit exceeded",
  );
  assert.equal(
    checkTradeLimit({ ...input, positionSize: -5n, executionNotional: 11n }),
    undefined,
    "reductions are exempt",
  );
});

test("checkChainTimeExpiry bounds deadlines by block time", () => {
  const { intent, approval } = buildFixture({ nowMs: 1_000_000 });
  assert.equal(checkChainTimeExpiry(intent, approval, 1_000, 5), undefined);
  assert.equal(error(checkChainTimeExpiry(intent, approval, 1_030, 5)), "chain-time expiry rejected");
  assert.equal(
    error(checkChainTimeExpiry({ ...intent, deadline: 2_000n }, approval, 1_031, 5)),
    "chain-time expiry rejected",
  );
  assert.equal(error(checkChainTimeExpiry(intent, approval, 993, 5)), "chain-time expiry rejected");
});

test("checkMarketEnabled admits only reductions in disabled markets", async () => {
  const { snapshot } = await setup(),
    disabled = { ...snapshot.markets[0], enabled: false };
  assert.equal(checkMarketEnabled(snapshot.markets[0], 0n, 1n), undefined);
  assert.equal(error(checkMarketEnabled(disabled, 0n, 1n)), "market disabled");
  assert.equal(checkMarketEnabled(disabled, -2n, 1n), undefined);
});

test("markedMarkets re-marks only the intent market", async () => {
  const { snapshot, markets } = await setup({ market: "ETH" });
  assert.equal(markets[0], snapshot.markets[0]);
  assert.equal(markets[1].lastBid, PRICES.ETH);
});

test("markedMarkets stores every newer price the report carries, as the contract does before its checks", async () => {
  const { snapshot, prices } = await setup({ market: "ETH" }),
    stored = snapshot.markets[0],
    newer = { market: 0n, bid: 1n, ask: 2n, observedAt: stored.lastPriceTime + 20n, validUntil: 0n },
    older = { ...newer, observedAt: stored.lastPriceTime - 1n };
  const marked = markedMarkets(snapshot, 1, prices, 1n, new Map([[0, newer]]));
  assert.deepEqual(
    [marked[0].lastBid, marked[0].lastAsk, marked[0].lastPriceTime],
    [1n, 2n, stored.lastPriceTime + 20n],
  );
  assert.equal(marked[1].lastBid, prices.bid, "the intent market keeps the verified safety prices");
  // Stored prices never move back in time (RFQLedger.touchOracle).
  assert.equal(markedMarkets(snapshot, 1, prices, 1n, new Map([[0, older]]))[0], stored);
});

test("checkExposure accepts new risk when the report refreshes another market's stale price", async () => {
  const context = await setup({ market: "BTC" }),
    later = BigInt(context.snapshot.blockTimestamp) + 16n,
    // ETH carries gross risk and its stored price is now 16 s old.
    snapshot: ChainSnapshot = {
      ...context.snapshot,
      blockTimestamp: Number(later),
      books: context.snapshot.books.map((book, index) =>
        index === 1 ? { ...book, longBase: BASE, shortBase: 0n } : book,
      ),
    },
    markets = (reported?: Map<number, OracleObservation>) =>
      markedMarkets(snapshot, 0, context.prices, later, reported);
  const exposure = (marked: ReturnType<typeof markets>) =>
    checkExposure({ ...context, snapshot, markets: marked })?.body as { reason?: string } | undefined;
  assert.equal(exposure(markets())?.reason, "stale_gross_price");
  const eth = snapshot.markets[1];
  assert.equal(
    exposure(
      markets(
        new Map([[1, { market: 1n, bid: eth.lastBid, ask: eth.lastAsk, observedAt: later, validUntil: 0n }]]),
      ),
    ),
    undefined,
  );
});

test("checkExposure surfaces the model's reason and enforces reduce-only intents", async () => {
  const context = await setup();
  assert.equal(checkExposure(context), undefined);
  const capped: ChainSnapshot = {
    ...context.snapshot,
    books: context.snapshot.books.map((book) => ({ ...book, limits: 1n | (1n << 128n) })),
  };
  const rejection = checkExposure({ ...context, snapshot: capped })!;
  assert.equal(rejection.body.error, "independent exposure check rejected");
  assert.ok(rejection.body.reason);
  assert.equal(
    error(checkExposure({ ...context, intent: { ...context.intent, reduceOnly: true } })),
    "reduce-only intent does not reduce position",
  );
});

test("checkCrossMarketFreshness requires a fresh other-market price while gross is outstanding", async () => {
  const { snapshot } = await setup(),
    book = new GrossReservationBook();
  assert.equal(checkCrossMarketFreshness(book, "0xnew", snapshot, 0), undefined);
  book.reserve("0xeth", { market: 1, baseDelta: BASE, reduceOnly: false, deadline: 1, makerDebit: 0n });
  assert.equal(checkCrossMarketFreshness(book, "0xnew", snapshot, 0), undefined);
  assert.equal(checkCrossMarketFreshness(book, "0xeth", snapshot, 0), undefined, "own reservation excluded");
  const stale: ChainSnapshot = { ...snapshot, blockTimestamp: snapshot.blockTimestamp + 16 };
  assert.equal(
    error(checkCrossMarketFreshness(book, "0xnew", stale, 0)),
    "outstanding gross risk requires fresh cross-market price",
  );
  const unpriced: ChainSnapshot = {
    ...snapshot,
    markets: [snapshot.markets[0], { ...snapshot.markets[1], lastPriceTime: 0n }],
  };
  assert.equal(
    error(checkCrossMarketFreshness(book, "0xnew", unpriced, 0)),
    "outstanding gross risk requires fresh cross-market price",
  );
  // The trade's own verified report prices ETH too, so the contract refreshes it before any check.
  assert.equal(checkCrossMarketFreshness(book, "0xnew", stale, 0, { covered: new Set([0, 1]) }), undefined);
  assert.equal(
    error(checkCrossMarketFreshness(book, "0xnew", stale, 0, { covered: new Set([0]) })),
    "outstanding gross risk requires fresh cross-market price",
  );
  // A reduction settles against another market's stale price on chain, so it is not held up here either.
  assert.equal(checkCrossMarketFreshness(book, "0xnew", unpriced, 0, { reduction: true }), undefined);
});

test("buildGrossContext uses safety asks and settled net notional", async () => {
  const context = await setup({ market: "ETH" }),
    gross = buildGrossContext({ ...context, position: context.snapshot.position });
  assert.deepEqual(gross.asks, [PRICES.BTC, PRICES.ETH]);
  assert.equal(gross.block, 100);
  assert.deepEqual(gross.risk.net, [0n, 0n]);
  assert(gross.makerDebit > 0n);
});

test("checkImpact requires the charged impact to be covered and delivered", async () => {
  for (const side of ["buy", "sell"] as const) {
    const context = await setup({ side, amount: "20000" });
    assert(context.approval.impactCharge > 0n);
    assert.equal(checkImpact(context), undefined, side);
    assert.equal(
      error(checkImpact({ ...context, approval: { ...context.approval, impactCharge: 0n } })),
      "independent impact check rejected",
      `${side}: undercharged impact`,
    );
    // Delivered impact is measured from the oracle mid, as the contract measures it.
    const anchor = context.prices.mark;
    assert.equal(
      error(checkImpact({ ...context, approval: { ...context.approval, executionPrice: anchor } })),
      "independent impact check rejected",
      `${side}: impact not delivered by the execution price`,
    );
    // Inside a wide oracle band, a fill at the mid plus impact is accepted.
    const band = 50_000_000n,
      wide = { bid: context.prices.mark - band, ask: context.prices.mark + band, mark: context.prices.mark };
    assert.equal(checkImpact({ ...context, prices: wide }), undefined, `${side}: inside a wide band`);
  }
});
