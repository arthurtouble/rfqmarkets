import assert from "node:assert/strict";
import { test } from "node:test";
import { Wallet } from "ethers";
import { checkUserAuthorization, checkUserSignature, recoverSigner } from "./authorization.js";
import { buildFixture } from "./test-fixtures.js";

const error = (rejection: { body: { error: string } } | undefined) => rejection?.body.error;

test("recoverSigner returns the ECDSA signer or undefined", () => {
  const { domain, intent, payload, user } = buildFixture();
  assert.equal(recoverSigner(domain, intent, payload.userSignature), user.address);
  assert.equal(recoverSigner(domain, intent, "0x1234"), undefined);
});

test("checkUserSignature binds the intent hash and, without a chain, the account signer", () => {
  const { approval, intent, user } = buildFixture(),
    input = {
      approval,
      intentHash: approval.intentHash,
      intentSigner: user.address,
      account: intent.account,
      requireAccountSigner: true,
    };
  assert.equal(checkUserSignature(input), undefined);
  const wrongHash = checkUserSignature({ ...input, intentHash: `0x${"11".repeat(32)}` })!;
  assert.equal(wrongHash.status, 401);
  assert.equal(wrongHash.body.error, "invalid user signature");
  assert.equal(error(checkUserSignature({ ...input, intentSigner: undefined })), "invalid user signature");
  assert.equal(
    checkUserSignature({ ...input, intentSigner: undefined, requireAccountSigner: false }),
    undefined,
    "chain mode resolves ERC-1271 and session signers later",
  );
});

test("checkUserAuthorization accepts account signatures and bounded sessions only", () => {
  const { intent, approval } = buildFixture(),
    notional = 1_000_000_000n,
    session = {
      account: intent.account,
      validUntil: intent.deadline,
      marketMask: 1,
      maxTradeNotional: notional,
      maxCumulativeNotional: 2n * notional,
      usedNotional: notional,
      maxFee: approval.fee,
    },
    input = { accountSignatureValid: false, session, intent, fee: approval.fee, notional };
  assert.equal(
    checkUserAuthorization({ ...input, accountSignatureValid: true, session: undefined }),
    undefined,
  );
  assert.equal(checkUserAuthorization(input), undefined);
  for (const changed of [
    undefined,
    { ...session, account: Wallet.createRandom().address },
    { ...session, validUntil: intent.deadline - 1n },
    { ...session, marketMask: 2 },
    { ...session, maxFee: approval.fee - 1n },
    { ...session, usedNotional: notional + 1n },
    { ...session, maxTradeNotional: notional - 1n },
  ])
    assert.equal(
      error(checkUserAuthorization({ ...input, session: changed })),
      "user authorization rejected",
    );
});
