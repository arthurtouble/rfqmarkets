// Checks every EIP-712 payload the API prepares before the SDK's signer signs it, mirroring the trading app's
// apps/web/src/wallet/verify-intent.ts. The API (or anything between it and this process) is not trusted to
// choose what the signer authorizes: the domain must be the settlement contract the client trusts, the types
// must be the protocol's own (bundled here, never the server's copies), the message must be for the requested
// account, and its fields must match the request. A mismatch throws IntentMismatchError and nothing is signed.

import { getAddress, isAddress } from "ethers";
import {
  cancelTypes,
  closeTypes,
  DOMAIN_NAME,
  DOMAIN_VERSION,
  intentTypes,
  isolatedMarginTypes,
  sessionGrantTypes,
  sessionRevokeTypes,
  triggeredIntentTypes,
  withdrawalTypes,
} from "../../shared/src/eip712.js";
import { triggerAboveFor, triggerLimitPrice, type TriggerKind } from "../../shared/src/trigger.js";

type Field = { name: string; type: string };
type Wire = Record<string, unknown>;
type Side = "buy" | "sell";

/** The protocol's signable types (packages/shared/src/eip712.ts mirrors contracts/RFQTypes.sol). */
export const SIGNABLE_TYPES: Record<string, Field[]> = {
  ...intentTypes,
  ...triggeredIntentTypes,
  ...withdrawalTypes,
  ...cancelTypes,
  ...isolatedMarginTypes,
  ...closeTypes,
  ...sessionRevokeTypes,
  ...sessionGrantTypes,
};

const BASE = 10n ** 18n;
/** Fee the API charges on resting orders (services/api/src/orders.ts ORDER_FEE_BPS). */
export const ORDER_FEE_BPS = 2n;
/** Ceiling on a market order's fee cap, in bps of its worst-case notional. */
export const MAX_TRADE_FEE_BPS = 50n;
/** How far a quote's expected price may sit past its own mid (spread plus impact), in bps. */
export const MAX_QUOTE_PREMIUM_BPS = 500n;
/** The API accepts 1..500 bps of slippage. */
export const MAX_SLIPPAGE_BPS = 500n;
/** A limit order's notional at its limit price may be at most this multiple of the amount asked for. */
export const LIMIT_NOTIONAL_FACTOR = 2n;

/** The settlement the client trusts and the account the message must be for. */
export type SigningContext = { chainId: bigint; clearing: string; account: string };

export type QuoteTerms = {
  baseDelta: bigint;
  worstPrice: bigint;
  expectedPrice: bigint;
  fee: bigint;
  amount: bigint;
  bid: bigint;
  ask: bigint;
};

/** What the caller asked for, per action. Amounts and prices are integers (USDC 1e6, base 1e18). */
export type Expectation =
  | {
      kind: "trade";
      market: number;
      side?: Side;
      reduceOnly: boolean;
      nonce: string;
      quote: QuoteTerms;
      amountMicro?: bigint;
      slippageBps?: number;
    }
  | {
      kind: "limit";
      market: number;
      side: Side;
      reduceOnly: boolean;
      nonce: string;
      amountMicro: bigint;
      limitPrice: bigint;
    }
  | {
      kind: "trigger";
      market: number;
      triggerKind: TriggerKind;
      triggerPrice: bigint;
      slippageBps: number;
      nonce: string;
      reduceOnly: boolean;
      side?: Side;
      amountMicro?: bigint;
    }
  | { kind: "withdraw"; recipient: string; amountMicro: bigint; nonce: string }
  | { kind: "isolated-margin"; market: number; amountMicro: bigint; nonce: string }
  /** The nonce a cancellation burns comes from the API's order record; only the account is checked. */
  | { kind: "cancel"; nonce?: string }
  | { kind: "close"; market: number; nonce: string }
  | { kind: "session-revoke"; session: string; nonce: string }
  | {
      kind: "session";
      session: string;
      marketMask: bigint;
      maxTradeNotional: bigint;
      maxCumulativeNotional: bigint;
      maxFee: bigint;
      durationSeconds: number;
      nonce: string;
    };

const EXPECTED_TYPE: Record<Expectation["kind"], string> = {
  trade: "TradeIntent",
  limit: "TradeIntent",
  trigger: "TriggeredTradeIntent",
  withdraw: "WithdrawalIntent",
  "isolated-margin": "IsolatedMarginIntent",
  cancel: "CancelIntent",
  close: "CloseIntent",
  "session-revoke": "SessionRevoke",
  session: "SessionGrant",
};

/** Thrown instead of signing a payload that does not match the request. */
export class IntentMismatchError extends Error {
  constructor(detail: string) {
    super(`refusing to sign: the prepared payload does not match the request (${detail})`);
    this.name = "IntentMismatchError";
  }
}

function check(ok: boolean, detail: string): asserts ok {
  if (!ok) throw new IntentMismatchError(detail);
}

const integer = (value: unknown, field: string): bigint => {
  check(
    (typeof value === "string" && /^-?\d{1,78}$/.test(value)) ||
      (typeof value === "number" && Number.isSafeInteger(value)) ||
      typeof value === "bigint",
    `${field} is not an integer`,
  );
  return BigInt(value as string | number | bigint);
};
const address = (value: unknown, field: string) => {
  check(typeof value === "string" && isAddress(value), `${field} is not an address`);
  return getAddress(value as string);
};
const bool = (value: unknown, field: string): boolean => {
  check(typeof value === "boolean", `${field} is not a boolean`);
  return value as boolean;
};
const abs = (value: bigint) => (value < 0n ? -value : value);
const ceilDiv = (a: bigint, b: bigint) => (a + b - 1n) / b;
const sideOf = (baseDelta: bigint): Side => (baseDelta > 0n ? "buy" : "sell");

function sameFields(actual: unknown, expected: readonly Field[]) {
  return (
    Array.isArray(actual) &&
    actual.length === expected.length &&
    actual.every(
      (field, index) =>
        field &&
        typeof field === "object" &&
        Object.keys(field).length === 2 &&
        field.name === expected[index].name &&
        field.type === expected[index].type,
    )
  );
}

/** The integer terms of a firm quote, for a `trade` expectation. Throws when the quote lacks them. */
export function quoteTerms(quote: Wire): QuoteTerms {
  return {
    bid: integer(quote.bid, "quote bid"),
    ask: integer(quote.ask, "quote ask"),
    baseDelta: integer(quote.baseDelta, "quote baseDelta"),
    worstPrice: integer(quote.worstPrice, "quote worstPrice"),
    expectedPrice: integer(quote.expectedPrice, "quote expectedPrice"),
    fee: integer(quote.fee, "quote fee"),
    amount: integer(quote.amount, "quote amount"),
  };
}

/**
 * Verifies `prepared` (the API's `{ domain, types }` plus `message`) against the trusted context and the
 * request, and returns the typed data to sign: the trusted domain, the bundled types and the checked message.
 */
export function verifyPrepared(
  prepared: { domain?: unknown; types?: unknown },
  message: Wire | undefined,
  primaryType: string,
  context: SigningContext,
  expectation: Expectation,
) {
  check(Object.hasOwn(SIGNABLE_TYPES, primaryType), `unknown message type ${primaryType}`);
  check(EXPECTED_TYPE[expectation.kind] === primaryType, `expected a ${EXPECTED_TYPE[expectation.kind]}`);
  const clearing = address(context.clearing, "trusted settlement contract"),
    account = address(context.account, "account");

  const domain = prepared?.domain as Wire | undefined;
  check(!!domain && typeof domain === "object", "missing signing domain");
  check(
    Object.keys(domain).every((key) => ["name", "version", "chainId", "verifyingContract"].includes(key)),
    "unexpected signing domain fields",
  );
  check(
    domain.name === DOMAIN_NAME && domain.version === DOMAIN_VERSION,
    "wrong signing domain name or version",
  );
  check(integer(domain.chainId, "domain chainId") === context.chainId, "wrong chain");
  check(
    address(domain.verifyingContract, "domain verifyingContract") === clearing,
    "wrong settlement contract",
  );

  const fields = SIGNABLE_TYPES[primaryType],
    types = prepared.types as Record<string, unknown> | undefined;
  check(
    !!types &&
      typeof types === "object" &&
      Object.keys(types).length === 1 &&
      sameFields(types[primaryType], fields),
    `wrong ${primaryType} type definition`,
  );

  check(!!message && typeof message === "object", "missing message");
  check(
    Object.keys(message).length === fields.length && fields.every((field) => field.name in message),
    "unexpected message fields",
  );
  check(address(message.account, "account") === account, "the message is for another account");
  verifyFields(message, expectation);

  return {
    domain: {
      name: DOMAIN_NAME,
      version: DOMAIN_VERSION,
      chainId: context.chainId,
      verifyingContract: clearing,
    },
    types: { [primaryType]: fields },
    message,
  };
}

function verifyFields(message: Wire, expectation: Expectation) {
  const nonce = integer(message.nonce, "nonce");
  if (expectation.nonce !== undefined) check(nonce === BigInt(expectation.nonce), "nonce changed");
  integer(message.deadline, "deadline");
  switch (expectation.kind) {
    case "withdraw":
      check(
        address(message.recipient, "recipient") === getAddress(expectation.recipient),
        "withdrawal recipient changed",
      );
      check(integer(message.amount, "amount") === expectation.amountMicro, "withdrawal amount changed");
      return;
    case "isolated-margin":
      check(Number(integer(message.market, "market")) === expectation.market, "market changed");
      check(integer(message.amount, "amount") === expectation.amountMicro, "margin amount changed");
      return;
    case "cancel":
      return;
    case "close":
      check(Number(integer(message.market, "market")) === expectation.market, "market changed");
      check(integer(message.limitPrice, "limitPrice") >= 0n, "close price limit is negative");
      return;
    case "session-revoke":
      check(address(message.session, "session") === getAddress(expectation.session), "session key changed");
      return;
    case "session": {
      check(address(message.session, "session") === getAddress(expectation.session), "session key changed");
      check(integer(message.marketMask, "marketMask") === expectation.marketMask, "session markets changed");
      check(
        integer(message.maxTradeNotional, "maxTradeNotional") === expectation.maxTradeNotional,
        "session per-trade limit changed",
      );
      check(
        integer(message.maxCumulativeNotional, "maxCumulativeNotional") === expectation.maxCumulativeNotional,
        "session total limit changed",
      );
      check(integer(message.maxFee, "maxFee") === expectation.maxFee, "session fee limit changed");
      // Against the grant's own deadline (chain time plus the API's short action window).
      check(
        integer(message.validUntil, "validUntil") <=
          integer(message.deadline, "deadline") + BigInt(expectation.durationSeconds),
        "session lasts longer than requested",
      );
      return;
    }
    default:
      return verifyTrade(message, expectation);
  }
}

function verifyTrade(
  message: Wire,
  expectation: Extract<Expectation, { kind: "trade" | "limit" | "trigger" }>,
) {
  const market = Number(integer(message.market, "market")),
    baseDelta = integer(message.baseDelta, "baseDelta"),
    limitPrice = integer(message.limitPrice, "limitPrice"),
    maxFee = integer(message.maxFee, "maxFee"),
    reduceOnly = bool(message.reduceOnly, "reduceOnly");
  check(market === expectation.market, "market changed");
  check(baseDelta !== 0n, "size is zero");
  check(limitPrice > 0n, "limit price is zero");
  check(maxFee >= 0n, "negative fee");
  // The API may add reduce-only (risk mode), which only narrows what the signature allows.
  check(!expectation.reduceOnly || reduceOnly, "reduce-only was removed");
  if (expectation.side) check(sideOf(baseDelta) === expectation.side, "trade side changed");
  const side = sideOf(baseDelta);

  if (expectation.kind === "trade") {
    const { quote } = expectation;
    check(baseDelta === quote.baseDelta, "size differs from the quote");
    check(
      side === "buy" ? limitPrice <= quote.worstPrice : limitPrice >= quote.worstPrice,
      "limit price is worse than the quote",
    );
    check(quote.expectedPrice > 0n && quote.amount > 0n, "quote has no price");
    const slippage =
      expectation.slippageBps === undefined ? MAX_SLIPPAGE_BPS : BigInt(expectation.slippageBps);
    const band = ceilDiv(quote.expectedPrice * (slippage + 1n), 10_000n);
    check(
      side === "buy"
        ? quote.worstPrice <= quote.expectedPrice + band
        : quote.worstPrice >= quote.expectedPrice - band,
      "quote's worst price is beyond the slippage",
    );
    check(quote.bid > 0n && quote.bid <= quote.ask, "quote has an invalid bid and ask");
    const mid = (quote.bid + quote.ask) / 2n,
      premium = ceilDiv(mid * MAX_QUOTE_PREMIUM_BPS, 10_000n);
    check(
      side === "buy"
        ? quote.expectedPrice >= mid && quote.expectedPrice <= mid + premium
        : quote.expectedPrice <= mid && quote.expectedPrice >= mid - premium,
      "quote price is too far from the market",
    );
    if (expectation.amountMicro !== undefined) {
      const notional = (abs(baseDelta) * mid) / BASE;
      check(
        notional * 10_000n <= expectation.amountMicro * 10_001n + 10_000n,
        "size is larger than requested",
      );
    }
    const protectedNotional = (abs(baseDelta) * quote.worstPrice) / BASE;
    const feeNotional =
      baseDelta < 0n
        ? ceilDiv(quote.amount * (2n * quote.expectedPrice - quote.worstPrice), quote.expectedPrice)
        : protectedNotional > quote.amount
          ? protectedNotional
          : quote.amount;
    check(maxFee <= ceilDiv(feeNotional * quote.fee, quote.amount), "fee cap is higher than the quote's fee");
    check(maxFee <= ceilDiv(feeNotional * MAX_TRADE_FEE_BPS, 10_000n), "fee cap is unreasonably high");
    return;
  }

  if (expectation.kind === "limit") {
    check(limitPrice === expectation.limitPrice, "limit price changed");
    check(reduceOnly === expectation.reduceOnly, "reduce-only changed");
    const notionalAtLimit = (abs(baseDelta) * limitPrice) / BASE;
    check(
      notionalAtLimit <= expectation.amountMicro * LIMIT_NOTIONAL_FACTOR,
      "size is larger than requested",
    );
    check(maxFee <= ceilDiv(notionalAtLimit * ORDER_FEE_BPS, 10_000n), "fee cap changed");
    return;
  }

  const triggerPrice = integer(message.triggerPrice, "triggerPrice"),
    triggerAbove = bool(message.triggerAbove, "triggerAbove");
  check(triggerPrice === expectation.triggerPrice, "trigger price changed");
  check(triggerAbove === triggerAboveFor(expectation.triggerKind, side), "trigger direction changed");
  const slippage = BigInt(expectation.slippageBps);
  check(slippage >= 1n && slippage <= MAX_SLIPPAGE_BPS, "slippage out of range");
  check(
    limitPrice === triggerLimitPrice(triggerPrice, side, slippage),
    "limit price differs from trigger and slippage",
  );
  if (expectation.triggerKind !== "stop-entry")
    check(reduceOnly, "stop-loss and take-profit must be reduce-only");
  if (expectation.amountMicro === undefined) check(reduceOnly, "a whole-position order must be reduce-only");
  else
    check(
      abs(baseDelta) === (expectation.amountMicro * BASE) / triggerPrice,
      "size differs from the amount at the trigger price",
    );
  const feePrice = side === "buy" ? limitPrice : triggerPrice * 2n;
  check(maxFee <= ceilDiv(((abs(baseDelta) * feePrice) / BASE) * ORDER_FEE_BPS, 10_000n), "fee cap changed");
}

/** Checks a TP/SL pair: the legs requested, in order (take-profit, then stop-loss), with one size and nonce. */
export function verifyTpslPair(
  legs: Array<{ type: string; intent?: Wire }>,
  request: { takeProfit: boolean; stopLoss: boolean },
) {
  const wanted = [request.takeProfit ? "take-profit" : null, request.stopLoss ? "stop-loss" : null].filter(
    Boolean,
  );
  check(
    legs.length === wanted.length && legs.every((leg, index) => leg.type === wanted[index]),
    "unexpected take-profit/stop-loss legs",
  );
  if (legs.length === 2) {
    check(String(legs[0].intent?.baseDelta) === String(legs[1].intent?.baseDelta), "leg sizes differ");
    check(String(legs[0].intent?.nonce) === String(legs[1].intent?.nonce), "leg nonces differ");
  }
}
