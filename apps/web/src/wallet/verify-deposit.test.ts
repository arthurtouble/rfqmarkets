import assert from "node:assert/strict";
import test from "node:test";
import { receiveAuthorizationTypes } from "../../../../services/api/src/deposits.js";
import { IntentMismatchError } from "./verify-intent.js";
import { RECEIVE_WITH_AUTHORIZATION, verifyDeposit, type PreparedDeposit } from "./verify-deposit.js";

const ACCOUNT = "0x1111111111111111111111111111111111111111";
const OTHER = "0x2222222222222222222222222222222222222222";
const CLEARING = "0x3333333333333333333333333333333333333333";
const TOKEN = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const NOW = 1_800_000_000;
const expected = { account: ACCOUNT, chainId: 8453, token: TOKEN, clearing: CLEARING, amount: 25_000_000n } as const;
const prepared = (): PreparedDeposit => ({
  domain: { name: "USD Coin", version: "2", chainId: "8453", verifyingContract: TOKEN },
  types: { ReceiveWithAuthorization: RECEIVE_WITH_AUTHORIZATION.map(field => ({ ...field })) },
  authorization: { from: ACCOUNT, to: CLEARING, value: "25000000", validAfter: "0", validBefore: String(NOW + 600), nonce: `0x${"ab".repeat(32)}` },
});
const refused = (change: (value: PreparedDeposit) => void, pattern: RegExp) => {
  const value = prepared();
  change(value);
  assert.throws(() => verifyDeposit(value, expected, NOW), (error: unknown) => error instanceof IntentMismatchError && pattern.test(error.message));
};

test("the bundled type matches the API's", () => {
  assert.deepEqual(RECEIVE_WITH_AUTHORIZATION, receiveAuthorizationTypes.ReceiveWithAuthorization);
});

test("a matching authorization becomes typed data on the trusted USDC domain", () => {
  const payload = verifyDeposit(prepared(), expected, NOW);
  assert.equal(payload.primaryType, "ReceiveWithAuthorization");
  assert.deepEqual(payload.domain, { name: "USD Coin", version: "2", chainId: 8453, verifyingContract: TOKEN });
  assert.equal(payload.message.to, CLEARING);
  assert.equal(payload.message.value, 25_000_000n);
});

test("refuses anything that would move other funds or to another place", () => {
  refused(value => { value.authorization.to = OTHER; }, /another recipient/);
  refused(value => { value.authorization.from = OTHER; }, /another account/);
  refused(value => { value.authorization.value = "25000001"; }, /another amount/);
  refused(value => { value.domain.verifyingContract = OTHER; }, /another token/);
  refused(value => { value.domain.chainId = "1"; }, /another chain/);
  refused(value => { value.types.ReceiveWithAuthorization[2]!.type = "uint128"; }, /unexpected type/);
  refused(value => { value.types = { TransferWithAuthorization: value.types.ReceiveWithAuthorization! }; }, /unexpected type/);
  refused(value => { value.authorization.validBefore = String(NOW + 86_400); }, /validity/);
  refused(value => { value.authorization.validAfter = String(NOW + 60); }, /validity/);
  refused(value => { value.authorization.nonce = "0x12"; }, /nonce/);
});
