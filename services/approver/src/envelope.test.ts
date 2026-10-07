import assert from "node:assert/strict";
import { test } from "node:test";
import {
  checkDomain,
  checkEnvelopeConsistency,
  checkVersions,
  checkWallClockExpiry,
  decodeEnvelope,
} from "./envelope.js";
import { CHAIN_ID, CLEARING, buildFixture } from "./test-fixtures.js";

const error = (rejection: { body: { error: string } } | undefined) => rejection?.body.error;

test("decodeEnvelope rejects malformed integers and addresses", () => {
  const { payload, domain, intent, approval } = buildFixture();
  assert.deepEqual(decodeEnvelope(payload), { domain, intent, approval, fill: intent });
  assert.equal(decodeEnvelope({ ...payload, intent: { ...payload.intent, account: "0x1234" } }), undefined);
  assert.equal(
    decodeEnvelope({ ...payload, domain: { ...payload.domain, verifyingContract: "nope" } }),
    undefined,
  );
});

test("checkDomain pins name, version, chain and clearing contract", () => {
  const { domain } = buildFixture(),
    expected = { chainId: CHAIN_ID, verifyingContract: CLEARING };
  assert.equal(checkDomain(domain, expected), undefined);
  assert.equal(checkDomain(domain, {}), undefined);
  for (const changed of [
    { ...domain, name: "Other" },
    { ...domain, version: "2" },
    { ...domain, chainId: 1n },
    { ...domain, verifyingContract: "0x00000000000000000000000000000000000000c2" },
  ])
    assert.equal(error(checkDomain(changed, expected)), "domain mismatch");
  const rejection = checkDomain({ ...domain, version: "2" }, expected)!;
  assert.equal(rejection.status, 409);
});

test("checkWallClockExpiry bounds intent and approval deadlines", () => {
  const { intent, approval, nowMs } = buildFixture(),
    seconds = BigInt(Math.floor(nowMs / 1000));
  assert.equal(checkWallClockExpiry(intent, approval, nowMs, 5), undefined);
  assert.equal(
    error(checkWallClockExpiry({ ...intent, deadline: seconds - 1n }, approval, nowMs, 5)),
    "invalid expiry",
  );
  assert.equal(
    error(checkWallClockExpiry(intent, { ...approval, deadline: seconds - 1n }, nowMs, 5)),
    "invalid expiry",
  );
  assert.equal(
    error(checkWallClockExpiry(intent, { ...approval, deadline: seconds + 37n }, nowMs, 5)),
    "invalid expiry",
  );
});

test("checkVersions compares each configured version", () => {
  const { approval } = buildFixture();
  assert.equal(checkVersions(approval, {}), undefined);
  assert.equal(checkVersions(approval, { epoch: 1, policyVersion: 1, signerSetVersion: 1 }), undefined);
  for (const expected of [{ epoch: 2 }, { policyVersion: 2 }, { signerSetVersion: 2 }])
    assert.equal(error(checkVersions(approval, expected)), "version mismatch");
});

test("checkEnvelopeConsistency rejects every field that diverges from the quote", () => {
  const { payload, intent, approval } = buildFixture(),
    quote = payload.quote;
  assert.equal(checkEnvelopeConsistency(quote, intent, approval), undefined);
  const cases: Array<[typeof quote, typeof intent, typeof approval]> = [
    [quote, { ...intent, market: 1 }, approval],
    [quote, { ...intent, baseDelta: intent.baseDelta + 1n }, approval],
    [quote, { ...intent, maxFee: approval.fee - 1n }, approval],
    [quote, { ...intent, limitPrice: approval.executionPrice - 1n }, approval],
    [quote, intent, { ...approval, executionPrice: approval.executionPrice + 1n }],
    [quote, intent, { ...approval, impactCharge: approval.impactCharge + 1n }],
    [{ ...quote, fee: "1" }, intent, approval],
    [quote, intent, { ...approval, deadline: intent.deadline + 1n }],
  ];
  for (const [q, i, a] of cases)
    assert.equal(error(checkEnvelopeConsistency(q, i, a)), "inconsistent envelope");
  const sell = buildFixture({ side: "sell" });
  assert.equal(checkEnvelopeConsistency(sell.payload.quote, sell.intent, sell.approval), undefined);
  assert.equal(
    error(
      checkEnvelopeConsistency(
        sell.payload.quote,
        { ...sell.intent, limitPrice: sell.approval.executionPrice + 1n },
        sell.approval,
      ),
    ),
    "inconsistent envelope",
  );
});
