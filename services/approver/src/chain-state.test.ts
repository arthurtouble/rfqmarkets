import assert from "node:assert/strict";
import { test } from "node:test";
import { Contract, Wallet } from "ethers";
import { clearingApproverAbi } from "../../../packages/shared/src/abi.js";
import {
  SESSION_LOOKBACK_BLOCKS,
  checkChainPolicy,
  readChainState,
  sessionGrantTracker,
  verifySignedReport,
  type ChainSnapshot,
} from "./chain-state.js";
import { CLEARING, LARGE, buildFixture, chainState, fakeChain, word } from "./test-fixtures.js";

const signer = Wallet.createRandom().address;

function request(fixture = buildFixture(), intentSigner: string | undefined = fixture.user.address) {
  return {
    chainId: fixture.domain.chainId,
    signer,
    intent: fixture.intent,
    intentHash: fixture.approval.intentHash,
    intentSigner,
    userSignature: fixture.payload.userSignature,
  };
}

async function snapshotOf(state = chainState(Date.now()), input = request()) {
  const result = await readChainState(fakeChain(state), input);
  assert("snapshot" in result, JSON.stringify("rejection" in result && result.rejection));
  return result.snapshot;
}

test("readChainState returns a typed snapshot pinned to one block", async () => {
  const state = chainState(Date.now());
  state.limitWords = [word(1n, 2n), word(3n, 4n)];
  const snapshot = await snapshotOf(state);
  assert.equal(snapshot.blockNumber, 100);
  assert.equal(snapshot.leaderEpoch, 1n);
  assert.deepEqual(snapshot.limitWords, [word(1n, 2n), word(3n, 4n)]);
  assert.equal(snapshot.markets[0].enabled, true);
  assert.equal(snapshot.books[1].ready, true);
  assert.equal(snapshot.accountSignatureValid, true);
  assert.equal(snapshot.session, undefined);
  const eth = buildFixture({ market: "ETH" });
  assert.deepEqual((await snapshotOf(state, request(eth))).limitWords, [word(1n, 2n), word(3n, 4n)]);
});

test("readChainState rejects chain-id mismatches, divergent RPCs and missing blocks", async () => {
  const reject = async (mutate: (state: ReturnType<typeof chainState>) => void) => {
    const state = chainState(Date.now());
    mutate(state);
    const result = await readChainState(fakeChain(state), request());
    return "rejection" in result ? result.rejection.body.error : undefined;
  };
  assert.equal(await reject((s) => (s.chainId = 1n)), "rpc chain mismatch");
  assert.equal(await reject((s) => (s.secondaryChainId = 1n)), "rpc chain mismatch");
  assert.equal(await reject((s) => (s.secondaryBlockHash = `0x${"cd".repeat(32)}`)), "rpc divergence");
  assert.equal(await reject((s) => (s.missingBlock = true)), "rpc divergence");
  const state = chainState(Date.now());
  state.missingBlock = true;
  const chain = fakeChain(state);
  delete chain.secondaryProvider;
  const result = await readChainState(chain, request());
  assert("rejection" in result);
  assert.equal(result.rejection.body.error, "independent chain policy rejected");
});

test("readChainState propagates read failures", async () => {
  const state = chainState(Date.now());
  state.failing = ["makerBacking"];
  await assert.rejects(readChainState(fakeChain(state), request()), /makerBacking unavailable/);
});

test("readChainState resolves ERC-1271 accounts and session signers", async () => {
  const fixture = buildFixture(),
    session = Wallet.createRandom().address,
    state = chainState(fixture.nowMs);
  state.sessions[session] = {
    account: fixture.intent.account,
    validUntil: 10n,
    marketMask: 3n,
    maxTradeNotional: 1n,
    maxCumulativeNotional: 2n,
    usedNotional: 0n,
    maxFee: 3n,
  };
  const chain = fakeChain(state);
  const result = await readChainState(chain, request(fixture, session));
  assert("snapshot" in result);
  assert.equal(result.snapshot.accountSignatureValid, false);
  assert.equal(result.snapshot.session?.marketMask, 3n);
  assert(chain.calls.includes("isValidSignature"));
  state.erc1271 = true;
  const contract = await snapshotOf(state, request(fixture, undefined));
  assert.equal(contract.accountSignatureValid, true);
  assert.equal(contract.session, undefined, "no session lookup without a recovered signer");
});

test("the approver's clearing ABI can filter session grants by account", () => {
  const clearing = new Contract(CLEARING, clearingApproverAbi);
  assert.equal(clearing.filters.SessionGranted(signer).fragment.name, "SessionGranted");
});

test("session grants are found newest first in bounded ranges and remembered per account", async () => {
  const account = Wallet.createRandom().address,
    [first, second] = [Wallet.createRandom().address, Wallet.createRandom().address],
    grants = [{ session: first, block: 20_000 }],
    ranges: Array<[number, number]> = [];
  const latest = sessionGrantTracker(async (granter, from, to) => {
    ranges.push([from, to]);
    return granter === account ? grants.filter((grant) => grant.block >= from && grant.block <= to) : [];
  });
  assert.equal(await latest(account, 21_500), first);
  // Newest first, at most 1,000 blocks a call, stopping at the range holding the grant.
  assert.deepEqual(ranges, [
    [20_501, 21_500],
    [19_501, 20_500],
  ]);
  ranges.length = 0;
  assert.equal(await latest(account, 21_510), first);
  assert.deepEqual(ranges, [[21_501, 21_510]]);
  grants.push({ session: second, block: 21_600 });
  assert.equal(await latest(account, 21_700), second);
  // A grant that falls out of the lookback window is no longer honoured.
  assert.equal(await latest(account, 21_600 + SESSION_LOOKBACK_BLOCKS + 1), undefined);
  assert.equal(await latest(Wallet.createRandom().address, 21_700), undefined);
});

test("enrolment is read once per signer set version", async () => {
  const state = chainState(Date.now()),
    chain = fakeChain(state),
    enrolments = () => chain.calls.filter((call) => call === "isApprover").length,
    read = async () => {
      const result = await readChainState(chain, request());
      assert("snapshot" in result);
      return result.snapshot.isApprover;
    };
  assert.equal(await read(), true);
  assert.equal(await read(), true);
  assert.equal(enrolments(), 1);
  // Removing the approver bumps the signer set version, so the next read sees it.
  state.isApprover = false;
  state.signerSetVersion = 2n;
  assert.equal(await read(), false);
  assert.equal(enrolments(), 2);
});

test("checkChainPolicy requires matching versions, an open venue and signer membership", async () => {
  const { approval } = buildFixture(),
    snapshot = await snapshotOf();
  assert.equal(checkChainPolicy(snapshot, approval), undefined);
  const variants: Array<Partial<ChainSnapshot>> = [
    { leaderEpoch: 2n },
    { signerSetVersion: 2n },
    { policyVersion: 2n },
    { paused: true },
    { resolutionRequired: true },
    { isApprover: false },
  ];
  for (const variant of variants)
    assert.equal(
      checkChainPolicy({ ...snapshot, ...variant }, approval)?.body.error,
      "independent chain policy rejected",
    );
});

test("verifySignedReport dry-runs the adapter and returns the market's observation", async () => {
  const state = chainState(Date.now());
  const btc = { market: 0n, bid: 5n, ask: 6n, observedAt: 7n, validUntil: LARGE };
  state.signedObservations = [btc, { ...btc, market: 1n }];
  const chain = fakeChain(state);
  assert.deepEqual(await verifySignedReport(chain, "0x01", CLEARING, 100, 0), btc);
  await assert.rejects(
    verifySignedReport(fakeChain({ ...state, signedObservations: [] }), "0x01", CLEARING, 100, 0),
  );
  assert.deepEqual(
    chain.calls.filter((call) => call === "oracle" || call === "eth_call"),
    ["oracle", "eth_call", "eth_call"],
  );
});

test("readChainState treats the owner as the signer of an isolated account", async () => {
  const fixture = buildFixture(),
    isolated = Wallet.createRandom().address,
    state = chainState(Date.now());
  state.isolatedOwners[isolated] = fixture.user.address;
  const input = { ...request(fixture), intent: { ...fixture.intent, account: isolated } };
  const snapshot = await snapshotOf(state, input);
  assert.equal(snapshot.signingAccount, fixture.user.address);
  assert.equal(snapshot.accountSignatureValid, true);
  // Without the isolated link, the owner's signature does not sign for that account.
  const ordinary = await snapshotOf(chainState(Date.now()), input);
  assert.equal(ordinary.signingAccount, isolated);
  assert.equal(ordinary.accountSignatureValid, false);
});
