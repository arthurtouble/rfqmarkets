// Checks the gas-free deposit the API prepares before the wallet signs it: a
// USDC ReceiveWithAuthorization from the connected account to the trusted
// clearing contract, for the amount asked, on the trusted USDC contract. Only
// the clearing contract can redeem it (USDC requires the caller to be `to`).
//
// Pure, so verify-deposit.test.ts runs it under Node.
import { getAddress, isAddress, type Address } from "viem";
import { IntentMismatchError } from "./verify-intent.js";

/** Native USDC's EIP-3009 type (FiatTokenV2). */
export const RECEIVE_WITH_AUTHORIZATION = [
  { name: "from", type: "address" },
  { name: "to", type: "address" },
  { name: "value", type: "uint256" },
  { name: "validAfter", type: "uint256" },
  { name: "validBefore", type: "uint256" },
  { name: "nonce", type: "bytes32" },
] as const;
/** The API never asks for an authorization that lives longer than this. */
const MAX_LIFETIME_SECONDS = 3_600;

export type PreparedDeposit = {
  domain: { name: string; version: string; chainId: string; verifyingContract: string };
  types: Record<string, Array<{ name: string; type: string }>>;
  authorization: { from: string; to: string; value: string; validAfter: string; validBefore: string; nonce: string };
};

export type DepositExpectation = { account: Address; chainId: number; token: Address; clearing: Address; amount: bigint };

const same = (value: unknown, expected: string) =>
  typeof value === "string" && isAddress(value, { strict: false }) && getAddress(value) === getAddress(expected);
const integer = (value: unknown) => {
  if (typeof value !== "string" || !/^\d+$/.test(value)) throw new IntentMismatchError("a malformed number");
  return BigInt(value);
};

/** The typed data to sign, or a thrown IntentMismatchError. */
export function verifyDeposit(prepared: PreparedDeposit, expected: DepositExpectation, nowSeconds = Math.floor(Date.now() / 1_000)) {
  const { domain, types, authorization } = prepared ?? ({} as PreparedDeposit);
  if (!domain || !types || !authorization) throw new IntentMismatchError("an incomplete deposit");
  if (typeof domain.name !== "string" || typeof domain.version !== "string") throw new IntentMismatchError("a malformed domain");
  if (integer(domain.chainId) !== BigInt(expected.chainId)) throw new IntentMismatchError("another chain");
  if (!same(domain.verifyingContract, expected.token)) throw new IntentMismatchError("another token contract");
  if (Object.keys(types).join() !== "ReceiveWithAuthorization" || JSON.stringify(types.ReceiveWithAuthorization) !== JSON.stringify(RECEIVE_WITH_AUTHORIZATION))
    throw new IntentMismatchError("an unexpected type");
  if (!same(authorization.from, expected.account)) throw new IntentMismatchError("another account");
  if (!same(authorization.to, expected.clearing)) throw new IntentMismatchError("another recipient");
  const value = integer(authorization.value), validAfter = integer(authorization.validAfter), validBefore = integer(authorization.validBefore);
  if (value !== expected.amount) throw new IntentMismatchError("another amount");
  if (validAfter > BigInt(nowSeconds) || validBefore <= BigInt(nowSeconds) || validBefore > BigInt(nowSeconds + MAX_LIFETIME_SECONDS))
    throw new IntentMismatchError("an unexpected validity window");
  if (typeof authorization.nonce !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(authorization.nonce)) throw new IntentMismatchError("a malformed nonce");
  return {
    domain: { name: domain.name, version: domain.version, chainId: expected.chainId, verifyingContract: getAddress(expected.token) },
    types: { ReceiveWithAuthorization: RECEIVE_WITH_AUTHORIZATION },
    primaryType: "ReceiveWithAuthorization" as const,
    message: {
      from: getAddress(expected.account),
      to: getAddress(expected.clearing),
      value,
      validAfter,
      validBefore,
      nonce: authorization.nonce as `0x${string}`,
    },
  };
}
