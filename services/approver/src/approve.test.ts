import assert from "node:assert/strict";
import { after, test } from "node:test";
import { encodeSignedReport } from "../../../packages/shared/src/signed-oracle.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AbiCoder, Wallet, keccak256 } from "ethers";
import { approvalToWire, hashApproval } from "../../../packages/shared/src/eip712.js";
import type { HedgeRiskSnapshot } from "../../../packages/shared/src/hedge-risk.js";
import { approve, type ApproverContext, type SignedApproval } from "./approve.js";
import { ApprovalJournal } from "./journal.js";
import type { ApproverOptions } from "./options.js";
import type { Rejection } from "./rejection.js";
import {
  CHAIN_ID,
  CLEARING,
  PRICES,
  buildFixture,
  chainState,
  fakeChain,
  word,
  type FakeChainState,
} from "./test-fixtures.js";

const directory = mkdtempSync(join(tmpdir(), "rfq-approver-"));
const journals: ApprovalJournal[] = [];
after(() => {
  for (const journal of journals) journal.close();
  rmSync(directory, { recursive: true, force: true });
});

function context(options: Partial<ApproverOptions> = {}, chain?: FakeChainState): ApproverContext {
  const wallet = Wallet.createRandom(),
    journal = new ApprovalJournal(join(directory, `${journals.length}.sqlite`), "test");
  journals.push(journal);
  return {
    options: {
      privateKey: wallet.privateKey,
      transportToken: "t",
      databasePath: "",
      expectedChainId: CHAIN_ID,
      expectedVerifyingContract: CLEARING,
      ...options,
    },
    signer: wallet.address,
    sign: (digest) => wallet.signingKey.sign(digest).serialized,
    journal,
    chain: chain && fakeChain(chain),
  };
}

const rejected = (result: Rejection | SignedApproval) => ("status" in result ? result : undefined);
const errorOf = (result: Rejection | SignedApproval) => rejected(result)?.body.error;

test("development mode signs a valid envelope once and returns the journaled signature on retry", async () => {
  const target = context(),
    fixture = buildFixture();
  const first = await approve(target, fixture.payload);
  assert(!("status" in first), JSON.stringify(first));
  assert.equal(first.digest, hashApproval(fixture.domain, fixture.approval));
  assert.equal(first.signer, target.signer);
  assert.deepEqual(await approve(target, fixture.payload), first);
  assert.equal(target.journal.gross.size, 1);
  assert.equal(target.journal.gross.capitalDebit(), 2n * BigInt(fixture.payload.quote.amount));
});

test("development mode rejects each pre-chain failure with its status and message", async () => {
  const fixture = buildFixture(),
    payload = fixture.payload,
    stale = Math.floor(fixture.nowMs / 1000) - 100;
  const cases: Array<[Partial<ApproverOptions>, typeof payload, number, string]> = [
    [{}, { ...payload, intent: { ...payload.intent, account: "0x12" } }, 400, "invalid typed data"],
    [{}, { ...payload, domain: { ...payload.domain, chainId: "1" } }, 409, "domain mismatch"],
    [{}, { ...payload, approval: { ...payload.approval, deadline: String(stale) } }, 409, "invalid expiry"],
    [{ expectedEpoch: 2 }, payload, 409, "version mismatch"],
    [{ expectedQuoteModelVersion: "v9" }, payload, 409, "quote model mismatch"],
    [
      {},
      { ...payload, quote: { ...payload.quote, spread: { ...payload.quote.spread!, totalBps: "9" } } },
      409,
      "quote spread rejected",
    ],
    [{}, { ...payload, quote: { ...payload.quote, fee: "0" } }, 409, "inconsistent envelope"],
    [{}, { ...payload, userSignature: buildFixture().payload.userSignature }, 401, "invalid user signature"],
    [
      {},
      {
        ...payload,
        oracleAgeMs: 1,
        approval: { ...payload.approval, oracleReportHash: `0x${"00".repeat(32)}` },
      },
      409,
      "oracle hash mismatch",
    ],
  ];
  for (const [options, input, status, error] of cases) {
    const result = rejected(await approve(context(options), input));
    assert.equal(result?.status, status, error);
    assert.equal(result?.body.error, error);
  }
  const unsigned = buildFixture({ spread: false });
  const lowFee = { ...unsigned.approval, fee: 0n },
    payloadLowFee = {
      ...unsigned.payload,
      quote: { ...unsigned.payload.quote, fee: "0" },
      approval: approvalToWire(lowFee),
    };
  assert.equal(errorOf(await approve(context(), payloadLowFee)), "policy rejected");
  const staleReport = buildFixture({ report: { observedAt: BigInt(stale) } });
  assert.equal(errorOf(await approve(context(), staleReport.payload)), "oracle report rejected");
});

test("development mode refuses while a legacy approval is incomplete and at reservation capacity", async () => {
  const target = context();
  Object.defineProperty(target.journal, "incompleteLegacy", { get: () => true });
  const legacy = rejected(await approve(target, buildFixture().payload));
  assert.equal(legacy?.status, 503);
  assert.equal(legacy?.body.error, "legacy approval recovery is incomplete");
  const full = context();
  Object.defineProperty(full.journal.gross, "size", { get: () => 50_000 });
  const capacity = rejected(await approve(full, buildFixture().payload));
  assert.equal(capacity?.status, 503);
  assert.equal(capacity?.body.error, "gross reservation capacity reached");
});

test("chain mode signs after independent reads and reserves the modelled maker debit", async () => {
  const fixture = buildFixture(),
    target = context({}, chainState(fixture.nowMs));
  const result = await approve(target, fixture.payload);
  assert(!("status" in result), JSON.stringify(result));
  const reserved = target.journal.gross.capitalDebit();
  assert(reserved > 0n && reserved !== 2n * BigInt(fixture.payload.quote.amount));
});

test("chain mode maps each chain-state rejection", async () => {
  const fixture = buildFixture();
  const cases: Array<[(state: FakeChainState) => void, string, Partial<ApproverOptions>?]> = [
    [(s) => (s.chainId = 1n), "rpc chain mismatch"],
    [(s) => (s.secondaryBlockHash = `0x${"cd".repeat(32)}`), "rpc divergence"],
    [(s) => (s.paused = true), "independent chain policy rejected"],
    [(s) => (s.limitWords = [word(1n, 10n ** 15n), s.limitWords[1]]), "market trade limit exceeded"],
    [(s) => (s.blockTimestamp += 40), "chain-time expiry rejected"],
    [(s) => (s.markets[0].enabled = false), "market disabled"],
    [(s) => (s.blockTimestamp += 9), "chain-time oracle rejected"],
    [(s) => (s.books[0].ready = false), "independent exposure check rejected"],
    [(s) => (s.backing = 0n), "independent exposure check rejected"],
  ];
  for (const [mutate, error] of cases) {
    const state = chainState(fixture.nowMs);
    mutate(state);
    const result = rejected(await approve(context({}, state), fixture.payload));
    assert.equal(result?.status, 409, error);
    assert.equal(result?.body.error, error);
  }
});

test("chain mode rejects foreign signers without a session", async () => {
  const fixture = buildFixture(),
    state = chainState(fixture.nowMs),
    target = context({}, state);
  // Same intent, signed by an unrelated key: the approval binds the intent
  // hash, and on chain only ERC-1271 or a session could authorize the signer.
  const signer = Wallet.createRandom(),
    signature = signer.signingKey.sign(fixture.approval.intentHash).serialized;
  assert.equal(
    errorOf(await approve(target, { ...fixture.payload, userSignature: signature })),
    "user authorization rejected",
  );
  state.sessions[signer.address] = {
    account: fixture.intent.account,
    validUntil: fixture.intent.deadline,
    marketMask: 1n,
    maxTradeNotional: 10n ** 12n,
    maxCumulativeNotional: 10n ** 12n,
    usedNotional: 0n,
    maxFee: fixture.approval.fee,
  };
  const result = await approve(target, { ...fixture.payload, userSignature: signature });
  assert(!("status" in result), JSON.stringify(result));
});

test("chain mode applies hedge risk and fails closed when the hedger is unavailable", async () => {
  const fixture = buildFixture(),
    hedgeRisk = { url: "http://hedger/internal/risk", token: "h" };
  const snapshot = (mode: "normal" | "reduce_only"): HedgeRiskSnapshot => ({
    observedAtMs: Date.now(),
    healthy: true,
    indexedBlock: 1,
    markets: {
      BTC: { mode, gapNotional: "0", bandUsdc: "0" },
      ETH: { mode, gapNotional: "0", bandUsdc: "0" },
    },
  });
  const serving = (body: HedgeRiskSnapshot | undefined) =>
    (async () => (body ? Response.json(body) : new Response("", { status: 500 }))) as unknown as typeof fetch;
  const run = (fetchImpl: typeof fetch) =>
    approve(context({ hedgeRisk, fetchImpl }, chainState(fixture.nowMs)), fixture.payload);
  const unavailable = rejected(await run(serving(undefined)));
  assert.equal(unavailable?.status, 503);
  assert.equal(unavailable?.body.error, "hedge health unavailable");
  assert.equal(
    errorOf(await run(serving(snapshot("reduce_only")))),
    "hedge risk requires exposure reduction",
  );
  assert.equal("status" in (await run(serving(snapshot("normal")))), false);
});

test("chain mode turns read failures into 503 and rejects excess gross capacity", async () => {
  const fixture = buildFixture(),
    failing = chainState(fixture.nowMs);
  failing.failing = ["exposureState"];
  const unavailable = rejected(await approve(context({}, failing), fixture.payload));
  assert.equal(unavailable?.status, 503);
  assert.equal(unavailable?.body.error, "independent chain read unavailable");
  const tight = chainState(fixture.nowMs),
    trade = BigInt(fixture.payload.quote.amount);
  tight.books[0].limits = word(trade + trade / 2n);
  const target = context({}, tight);
  assert.equal("status" in (await approve(target, fixture.payload)), false);
  const second = buildFixture({ nowMs: fixture.nowMs });
  assert.equal(
    errorOf(await approve(target, second.payload)),
    "independent outstanding gross, net, stress or capital capacity exceeded",
  );
});

test("signed mode validates the adapter's consensus observation", async () => {
  const fixture = buildFixture(),
    nowSeconds = BigInt(Math.floor(fixture.nowMs / 1000)),
    report = encodeSignedReport([
      {
        observedAt: Number(nowSeconds),
        prices: [{ market: 0, bid: PRICES.BTC, ask: PRICES.BTC }],
        signature: "0x01",
      },
    ]);
  const payload = {
    ...fixture.payload,
    report,
    approval: { ...fixture.payload.approval, oracleReportHash: keccak256(report) },
  };
  const state = chainState(fixture.nowMs);
  const consensus = {
    market: 0n,
    bid: PRICES.BTC + 1_000n,
    ask: PRICES.BTC + 1_000n,
    observedAt: nowSeconds,
    validUntil: nowSeconds + 60n,
  };
  state.signedObservations = [consensus];
  const result = await approve(context({ oracleMode: "signed" }, state), payload);
  assert(!("status" in result), JSON.stringify(result));
  state.signedObservations = [{ ...consensus, market: 1n }];
  assert.equal(
    errorOf(await approve(context({ oracleMode: "signed" }, state), payload)),
    "oracle report rejected",
  );
  state.signedObservations = [{ ...consensus, observedAt: nowSeconds - 20n }];
  assert.equal(
    errorOf(await approve(context({ oracleMode: "signed" }, state), payload)),
    "chain-time oracle rejected",
  );
});
