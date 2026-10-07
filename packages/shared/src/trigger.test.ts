import assert from "node:assert/strict";
import { test } from "node:test";
import { AbiCoder, TypedDataEncoder, Wallet, keccak256, toUtf8Bytes } from "ethers";
import {
  hashIntent,
  hashTriggeredIntent,
  intentDigest,
  recoverDigestSigner,
  triggeredIntentToWire,
  triggeredIntentTypes,
  type SigningDomain,
  type TradeIntent,
} from "./eip712.js";
import { USDC, legMargin, marketMarginView, maxLeverage, scaledMarginRate } from "./pricing.js";
import { triggerAboveFor, triggerLimitPrice, triggerReached, triggeredFillDelta } from "./trigger.js";

const domain: SigningDomain = {
  name: "RFQ Markets",
  version: "1",
  chainId: 31_337n,
  verifyingContract: "0x00000000000000000000000000000000000000C1",
};
const intent: TradeIntent = {
  account: "0x00000000000000000000000000000000000000A1",
  market: 0,
  baseDelta: -(10n ** 16n),
  limitPrice: 94_050n * USDC,
  maxFee: 200_000n,
  nonce: 9n,
  deadline: 2_000_000_000n,
  reduceOnly: true,
};
const trigger = { triggerPrice: 95_000n * USDC, triggerAbove: false };

test("the triggered intent digest matches RFQSignatureVerifier's struct hash", () => {
  const typeHash = keccak256(
    toUtf8Bytes(
      "TriggeredTradeIntent(address account,uint8 market,int256 baseDelta,uint256 limitPrice,uint256 maxFee,uint256 nonce,uint64 deadline,bool reduceOnly,uint256 triggerPrice,bool triggerAbove)",
    ),
  );
  const structHash = keccak256(
    AbiCoder.defaultAbiCoder().encode(
      [
        "bytes32",
        "address",
        "uint8",
        "int256",
        "uint256",
        "uint256",
        "uint256",
        "uint64",
        "bool",
        "uint256",
        "bool",
      ],
      [
        typeHash,
        intent.account,
        intent.market,
        intent.baseDelta,
        intent.limitPrice,
        intent.maxFee,
        intent.nonce,
        intent.deadline,
        intent.reduceOnly,
        trigger.triggerPrice,
        trigger.triggerAbove,
      ],
    ),
  );
  const digest = keccak256(
    `0x1901${TypedDataEncoder.hashDomain(domain).slice(2)}${structHash.slice(2)}` as `0x${string}`,
  );
  assert.equal(hashTriggeredIntent(domain, intent, trigger), digest);
  assert.equal(intentDigest(domain, intent, trigger), digest);
  assert.equal(intentDigest(domain, intent), hashIntent(domain, intent));
  assert.notEqual(digest, hashIntent(domain, intent));
});

test("a wallet signature over the wire message recovers only in its triggered form", async () => {
  const wallet = Wallet.createRandom(),
    wire = triggeredIntentToWire({ ...intent, account: wallet.address }, trigger),
    signature = await wallet.signTypedData(domain, triggeredIntentTypes, wire),
    signed = { ...intent, account: wallet.address };
  assert.equal(recoverDigestSigner(domain, signed, signature, trigger), wallet.address);
  assert.notEqual(
    recoverDigestSigner(domain, signed, signature, { ...trigger, triggerPrice: 1n }),
    wallet.address,
  );
  assert.notEqual(recoverDigestSigner(domain, signed, signature), wallet.address);
});

test("trigger mid, clamp, direction and limit price mirror the contract and the order rules", () => {
  // The contract compares (bid + ask) / 2, rounded down.
  assert.equal(triggerReached(95_000n, 95_001n, { triggerPrice: 95_000n, triggerAbove: false }), true);
  assert.equal(triggerReached(95_000n, 95_003n, { triggerPrice: 95_000n, triggerAbove: false }), false);
  assert.equal(triggerReached(95_000n, 95_001n, { triggerPrice: 95_000n, triggerAbove: true }), true);
  assert.equal(triggerReached(94_998n, 95_001n, { triggerPrice: 95_000n, triggerAbove: true }), false);

  assert.equal(triggeredFillDelta({ baseDelta: -10n, reduceOnly: true }, 4n), -4n);
  assert.equal(triggeredFillDelta({ baseDelta: -10n, reduceOnly: true }, 12n), -10n);
  assert.equal(triggeredFillDelta({ baseDelta: -10n, reduceOnly: false }, 4n), -10n);
  assert.equal(triggeredFillDelta({ baseDelta: -10n, reduceOnly: true }, -4n), -10n);
  assert.equal(triggeredFillDelta({ baseDelta: 10n, reduceOnly: true }, -4n), 4n);

  assert.equal(triggerAboveFor("stop-loss", "sell"), false);
  assert.equal(triggerAboveFor("stop-loss", "buy"), true);
  assert.equal(triggerAboveFor("take-profit", "sell"), true);
  assert.equal(triggerAboveFor("take-profit", "buy"), false);
  assert.equal(triggerAboveFor("stop-entry", "buy"), true);
  assert.equal(triggerAboveFor("stop-entry", "sell"), false);

  assert.equal(triggerLimitPrice(95_000n * USDC, "sell", 100n), 94_050n * USDC);
  assert.equal(triggerLimitPrice(95_000n * USDC, "buy", 100n), 95_950n * USDC);
  assert.equal(triggerLimitPrice(3n, "buy", 1n), 4n);
  assert.equal(triggerLimitPrice(3n, "sell", 1n), 2n);
});

test("scaled margin mirrors RFQRiskMath.scaledMarginRate across the governance range", () => {
  assert.equal(scaledMarginRate(10_000n * USDC, true, 2_500), 500n);
  assert.equal(scaledMarginRate(10_000n * USDC, false, 2_500), 300n);
  assert.equal(scaledMarginRate(10_000n * USDC, true, 10_000), 2_000n);
  assert.equal(scaledMarginRate(50_000n * USDC, true, 2_500), 625n);
  // Capped at 100%.
  assert.equal(scaledMarginRate(9_000_000n * USDC, true, 50_000), 10_000n);
  assert.equal(scaledMarginRate(9_000_000n * USDC, false, 20_000), 10_000n);
  // Truncating division like the contract: 2_000 * 3_333 / 10_000 = 666.6.
  assert.equal(scaledMarginRate(1n, true, 3_333), 666n);
  assert.equal(legMargin(10_000n * USDC, true, 2_500), 500n * USDC);
  assert.equal(maxLeverage(2_500), 20);
  assert.equal(maxLeverage(10_000), 5);
  assert.equal(maxLeverage(12_000), 4.16);
  assert.deepEqual(marketMarginView(2_500), {
    marginScaleBps: 2_500,
    maxLeverage: 20,
    initialMarginBps: 500,
    maintenanceMarginBps: 300,
  });
});
