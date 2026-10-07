import assert from "node:assert/strict";
import { test } from "node:test";
import { Wallet, recoverAddress } from "ethers";
import { referralBonus, referralDigest, referralTermsError, referralTypes } from "./referrals.js";

test("referral terms refuse self-referral and stale signatures", () => {
  const account = "0x0000000000000000000000000000000000000002",
    referrer = "0x0000000000000000000000000000000000000003";
  assert.equal(referralTermsError({ account, referrer, issuedAt: 1_000 }, 1_500), undefined);
  assert.equal(
    referralTermsError({ account, referrer: account, issuedAt: 1_000 }, 1_000),
    "an account cannot refer itself",
  );
  assert.equal(referralTermsError({ account, referrer, issuedAt: 1_000 }, 1_601), "referral expired");
  assert.equal(referralTermsError({ account, referrer, issuedAt: 2_000 }, 1_000), "referral expired");
});

test("the digest matches what a wallet signs, and the bonus is 10% rounded down", async () => {
  const wallet = Wallet.createRandom(),
    clearing = "0x0000000000000000000000000000000000000001",
    referral = { account: wallet.address, referrer: clearing, issuedAt: 1_700_000_000 },
    signature = await wallet.signTypedData(
      { name: "RFQ Markets", version: "1", chainId: 8_453n, verifyingContract: clearing },
      referralTypes,
      referral,
    );
  assert.equal(recoverAddress(referralDigest(8_453n, clearing, referral), signature), wallet.address);
  assert.equal(referralBonus([15n, 4n]), 1n);
  assert.equal(referralBonus([]), 0n);
});
