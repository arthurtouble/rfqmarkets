import assert from "node:assert/strict";
import { test } from "node:test";
import { Wallet } from "ethers";
import { checkChainPolicy, readChainState, verifyPythReport, type ChainSnapshot } from "./chain-state.js";
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
  assert.equal(result.snapshot.session?.marketMask, 3);
  assert(chain.calls.includes("isValidSignature"));
  state.erc1271 = true;
  const contract = await snapshotOf(state, request(fixture, undefined));
  assert.equal(contract.accountSignatureValid, true);
  assert.equal(contract.session, undefined, "no session lookup without a recovered signer");
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

test("verifyPythReport dry-runs the adapter and returns its observation", async () => {
  const state = chainState(Date.now());
  state.pythObservation = { market: 0n, bid: 5n, ask: 6n, observedAt: 7n, validUntil: LARGE };
  const chain = fakeChain(state);
  assert.deepEqual(await verifyPythReport(chain, "0x01", CLEARING, 100), state.pythObservation);
  assert.deepEqual(
    chain.calls.filter((call) => call === "oracle" || call === "eth_call"),
    ["oracle", "eth_call", "eth_call"],
  );
});
