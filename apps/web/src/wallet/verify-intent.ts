// Checks every EIP-712 payload the API prepares before a wallet or the
// one-click key signs it. The API (or anything between it and the browser)
// is not trusted to choose what the user authorizes: the domain must be the
// settlement contract this build trusts, the types must be the protocol's own,
// the signer must be the connected account and the fields must match what the
// user asked for. A mismatch throws IntentMismatchError and nothing is signed.
//
// Pure, so it is unit tested without a wallet (verify-intent.test.ts).
import { getAddress, isAddress, type Address, type TypedDataDomain } from "viem";
import { triggerAboveFor, triggerLimitPrice } from "../../../../packages/shared/src/trigger.js";
import type { Prepared, Side, TriggerKind } from "../lib/types.js";

/** `RFQTypes.sol` EIP712_NAME_HASH / EIP712_VERSION_HASH (packages/shared/src/eip712.ts). */
export const DOMAIN_NAME = "RFQ Markets";
export const DOMAIN_VERSION = "1";

type Field = { name: string; type: string };
const TRADE_FIELDS: Field[] = [
  { name: "account", type: "address" },
  { name: "market", type: "uint8" },
  { name: "baseDelta", type: "int256" },
  { name: "limitPrice", type: "uint256" },
  { name: "maxFee", type: "uint256" },
  { name: "nonce", type: "uint256" },
  { name: "deadline", type: "uint64" },
  { name: "reduceOnly", type: "bool" },
];

/**
 * The type definitions the user may sign, copied from packages/shared/src/eip712.ts (which mirrors
 * the type hashes in contracts/RFQTypes.sol). Bundled rather than imported so the trading app does not
 * pull ethers; verify-intent.test.ts asserts the copies stay identical.
 */
export const SIGNABLE_TYPES = {
  TradeIntent: TRADE_FIELDS,
  TriggeredTradeIntent: [...TRADE_FIELDS, { name: "triggerPrice", type: "uint256" }, { name: "triggerAbove", type: "bool" }],
  WithdrawalIntent: [
    { name: "account", type: "address" },
    { name: "recipient", type: "address" },
    { name: "amount", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint64" },
  ],
  CancelIntent: [
    { name: "account", type: "address" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint64" },
  ],
  CloseIntent: [
    { name: "account", type: "address" },
    { name: "market", type: "uint8" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint64" },
  ],
  SessionGrant: [
    { name: "account", type: "address" },
    { name: "session", type: "address" },
    { name: "marketMask", type: "uint256" },
    { name: "maxTradeNotional", type: "uint128" },
    { name: "maxCumulativeNotional", type: "uint128" },
    { name: "maxFee", type: "uint128" },
    { name: "validUntil", type: "uint64" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint64" },
  ],
} as const satisfies Record<string, readonly Field[]>;
export type PrimaryType = keyof typeof SIGNABLE_TYPES;

const BASE = 10n ** 18n;
/** Fee the API charges on resting orders (services/api/src/orders.ts ORDER_FEE_BPS). */
export const ORDER_FEE_BPS = 2n;
/** Ceiling on a market order's fee cap, in bps of its worst-case notional. The launch fee is 2 bps. */
export const MAX_TRADE_FEE_BPS = 50n;
/**
 * How far a quote's expected price may sit past its own mid (spread plus impact), in bps. The API sizes
 * a quote at the mid, so this bounds how much a tampered mid could enlarge a trade.
 */
export const MAX_QUOTE_PREMIUM_BPS = 500n;
/** POST /v1/quote and trigger orders accept 1..500 bps (packages/shared MAX_SLIPPAGE_BPS). */
export const MAX_SLIPPAGE_BPS = 500n;
/**
 * A limit order is sized by the API at the current price, which the browser cannot verify. Its notional
 * at the user's limit price may be at most this multiple of the amount asked for: a buy limit above or a
 * sell limit below the market by more than 2x is refused, and a tampered size is caught within 2x.
 */
export const LIMIT_NOTIONAL_FACTOR = 2n;

/** Who signs and for which contract: the connected account and the settlement this build trusts. */
export type SigningContext = { account: string; chainId: number | bigint; clearing: string | null | undefined };

/** What the user asked for, per action. Amounts and prices are integers (USDC 1e6, base 1e18). */
export type Expectation =
  /** An immediate trade at a firm quote. `amountMicro` is what the user asked for (absent for closes). */
  | { kind: "trade"; market: number; side?: Side; reduceOnly: boolean; nonce: string;
      quote: { baseDelta: bigint; worstPrice: bigint; expectedPrice: bigint; fee: bigint; amount: bigint; bid: bigint; ask: bigint };
      amountMicro?: bigint; slippageBps?: number }
  | { kind: "limit"; market: number; side: Side; reduceOnly: boolean; nonce: string; amountMicro: bigint; limitPrice: bigint }
  | { kind: "trigger"; market: number; triggerKind: TriggerKind; triggerPrice: bigint; slippageBps: number; nonce: string;
      reduceOnly: boolean; side?: Side; amountMicro?: bigint }
  | { kind: "withdraw"; amountMicro: bigint; nonce: string }
  | { kind: "cancel"; nonce: string }
  | { kind: "close"; market: number; nonce: string }
  | { kind: "session"; session: string; marketMask: bigint; maxTradeNotional: bigint; maxCumulativeNotional: bigint;
      maxFee: bigint; durationSeconds: number; nonce: string };

const EXPECTED_TYPE: Record<Expectation["kind"], PrimaryType> = {
  trade: "TradeIntent", limit: "TradeIntent", trigger: "TriggeredTradeIntent", withdraw: "WithdrawalIntent",
  cancel: "CancelIntent", close: "CloseIntent", session: "SessionGrant",
};

/** Thrown instead of signing a payload that does not match the request. The message is shown to the user. */
export class IntentMismatchError extends Error {
  constructor(detail: string) {
    super(`Signature refused: the server's request does not match what you asked for (${detail}). Nothing was signed. Reload the page and try again; contact support if it keeps happening.`);
    this.name = "IntentMismatchError";
  }
}

function check(ok: boolean, detail: string): asserts ok {
  if (!ok) throw new IntentMismatchError(detail);
}

const integer = (value: unknown, field: string): bigint => {
  check((typeof value === "string" && /^-?\d{1,78}$/.test(value)) || (typeof value === "number" && Number.isSafeInteger(value)) || typeof value === "bigint", `${field} is not an integer`);
  return BigInt(value as string | number | bigint);
};
const address = (value: unknown, field: string): Address => {
  check(typeof value === "string" && isAddress(value, { strict: false }), `${field} is not an address`);
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
  return Array.isArray(actual) && actual.length === expected.length
    && actual.every((field, index) => field && typeof field === "object"
      && Object.keys(field).length === 2 && field.name === expected[index].name && field.type === expected[index].type);
}

/**
 * Verifies `prepared` against the trusted signing context and the user's request, and returns the typed
 * data to sign, built from the trusted domain and the bundled types (never the server's copies).
 */
export function verifyPrepared(prepared: Prepared, primaryType: string, context: SigningContext, expectation: Expectation) {
  check(primaryType in SIGNABLE_TYPES, `unknown message type ${primaryType}`);
  const type = primaryType as PrimaryType;
  check(EXPECTED_TYPE[expectation.kind] === type, `expected a ${EXPECTED_TYPE[expectation.kind]}, got ${type}`);
  check(!!context.clearing && isAddress(context.clearing, { strict: false }), "the settlement contract is not configured");
  const clearing = getAddress(context.clearing!), chainId = BigInt(context.chainId);
  const account = address(context.account, "connected account");

  const domain = prepared?.domain;
  check(!!domain && typeof domain === "object", "missing signing domain");
  check(Object.keys(domain).every(key => ["name", "version", "chainId", "verifyingContract"].includes(key)), "unexpected signing domain fields");
  check(domain.name === DOMAIN_NAME && domain.version === DOMAIN_VERSION, "wrong signing domain name or version");
  check(integer(domain.chainId, "domain chainId") === chainId, "wrong chain");
  check(address(domain.verifyingContract, "domain verifyingContract") === clearing, "wrong settlement contract");

  const types = prepared.types;
  check(!!types && typeof types === "object" && Object.keys(types).length === 1 && sameFields(types[type], SIGNABLE_TYPES[type]), `wrong ${type} type definition`);

  const message = prepared.intent as Record<string, unknown>;
  check(!!message && typeof message === "object", "missing message");
  const fields = SIGNABLE_TYPES[type];
  check(Object.keys(message).length === fields.length && fields.every(field => field.name in message), "unexpected message fields");
  check(address(message.account, "account") === account, "the message is for another account");

  verifyFields(message, expectation, account);

  const trustedDomain: TypedDataDomain = { name: DOMAIN_NAME, version: DOMAIN_VERSION, chainId: Number(chainId), verifyingContract: clearing };
  return { domain: trustedDomain, types: { [type]: fields } as Record<string, readonly Field[]>, primaryType: type, message };
}

function verifyFields(message: Record<string, unknown>, expectation: Expectation, account: Address) {
  check(integer(message.nonce, "nonce") === BigInt(expectation.nonce), "nonce changed");
  integer(message.deadline, "deadline");
  switch (expectation.kind) {
    case "withdraw":
      check(address(message.recipient, "recipient") === account, "withdrawal recipient is not your wallet");
      check(integer(message.amount, "amount") === expectation.amountMicro, "withdrawal amount changed");
      return;
    case "cancel":
      return;
    case "close":
      check(Number(integer(message.market, "market")) === expectation.market, "market changed");
      return;
    case "session": {
      check(address(message.session, "session") === getAddress(expectation.session), "session key is not the one this tab created");
      check(integer(message.marketMask, "marketMask") === expectation.marketMask, "session markets changed");
      check(integer(message.maxTradeNotional, "maxTradeNotional") === expectation.maxTradeNotional, "session per-trade limit changed");
      check(integer(message.maxCumulativeNotional, "maxCumulativeNotional") === expectation.maxCumulativeNotional, "session total limit changed");
      check(integer(message.maxFee, "maxFee") === expectation.maxFee, "session fee limit changed");
      // Measured against the grant's own deadline (chain time plus the API's short action window), so a
      // local chain whose clock runs ahead does not matter.
      const validUntil = integer(message.validUntil, "validUntil"), deadline = integer(message.deadline, "deadline");
      check(validUntil <= deadline + BigInt(expectation.durationSeconds), "session lasts longer than requested");
      return;
    }
    default:
      return verifyTrade(message, expectation);
  }
}

function verifyTrade(message: Record<string, unknown>, expectation: Extract<Expectation, { kind: "trade" | "limit" | "trigger" }>) {
  const market = Number(integer(message.market, "market")), baseDelta = integer(message.baseDelta, "baseDelta");
  const limitPrice = integer(message.limitPrice, "limitPrice"), maxFee = integer(message.maxFee, "maxFee");
  const reduceOnly = bool(message.reduceOnly, "reduceOnly");
  check(market === expectation.market, "market changed");
  check(baseDelta !== 0n, "size is zero");
  check(limitPrice > 0n, "limit price is zero");
  check(maxFee >= 0n, "negative fee");
  // A reduce-only request must stay reduce-only. The API may add reduce-only (risk mode), which only
  // narrows what the signature allows.
  check(!expectation.reduceOnly || reduceOnly, "reduce-only was removed");
  if (expectation.side) check(sideOf(baseDelta) === expectation.side, "trade side changed");
  const side = sideOf(baseDelta);

  if (expectation.kind === "trade") {
    const { quote } = expectation;
    check(baseDelta === quote.baseDelta, "size differs from the quote");
    check(side === "buy" ? limitPrice <= quote.worstPrice : limitPrice >= quote.worstPrice, "limit price is worse than the quote");
    check(quote.expectedPrice > 0n && quote.amount > 0n, "quote has no price");
    const slippage = expectation.slippageBps === undefined ? MAX_SLIPPAGE_BPS : BigInt(expectation.slippageBps);
    // The quoted worst price may sit at most the allowed slippage (+1 bps for rounding) past the expected price.
    const band = ceilDiv(quote.expectedPrice * (slippage + 1n), 10_000n);
    check(side === "buy" ? quote.worstPrice <= quote.expectedPrice + band : quote.worstPrice >= quote.expectedPrice - band, "quote's worst price is beyond your slippage");
    // packages/shared constructQuote: the size is the amount at the mid, (bid + ask) / 2, and the expected
    // price is the mid plus spread and impact against the trader.
    check(quote.bid > 0n && quote.bid <= quote.ask, "quote has an invalid bid and ask");
    const mid = (quote.bid + quote.ask) / 2n, premium = ceilDiv(mid * MAX_QUOTE_PREMIUM_BPS, 10_000n);
    check(side === "buy" ? quote.expectedPrice >= mid && quote.expectedPrice <= mid + premium : quote.expectedPrice <= mid && quote.expectedPrice >= mid - premium, "quote price is too far from the market");
    if (expectation.amountMicro !== undefined) {
      // Within 1 bps (and one unit) for rounding.
      const notional = (abs(baseDelta) * mid) / BASE;
      check(notional * 10_000n <= expectation.amountMicro * 10_001n + 10_000n, "size is larger than you asked for");
    }
    // Mirrors services/api execution.ts makeIntent, plus an absolute ceiling because quote.fee is the server's.
    // A sell has no upper price bound, so its fee cap lets the notional rise by as much as its protection
    // lets the price fall.
    const protectedNotional = (abs(baseDelta) * quote.worstPrice) / BASE;
    const feeNotional =
      baseDelta < 0n
        ? ceilDiv(quote.amount * (2n * quote.expectedPrice - quote.worstPrice), quote.expectedPrice)
        : protectedNotional > quote.amount ? protectedNotional : quote.amount;
    check(maxFee <= ceilDiv(feeNotional * quote.fee, quote.amount), "fee cap is higher than the quote's fee");
    check(maxFee <= ceilDiv(feeNotional * MAX_TRADE_FEE_BPS, 10_000n), "fee cap is unreasonably high");
    return;
  }

  if (expectation.kind === "limit") {
    check(limitPrice === expectation.limitPrice, "limit price changed");
    check(reduceOnly === expectation.reduceOnly, "reduce-only changed");
    const notionalAtLimit = (abs(baseDelta) * limitPrice) / BASE;
    check(notionalAtLimit <= expectation.amountMicro * LIMIT_NOTIONAL_FACTOR, "size is larger than you asked for");
    check(maxFee <= ceilDiv(notionalAtLimit * ORDER_FEE_BPS, 10_000n), "fee cap changed");
    return;
  }

  // Triggered order: the signed trigger and limit are fully determined by the request.
  const triggerPrice = integer(message.triggerPrice, "triggerPrice"), triggerAbove = bool(message.triggerAbove, "triggerAbove");
  check(triggerPrice === expectation.triggerPrice, "trigger price changed");
  check(triggerAbove === triggerAboveFor(expectation.triggerKind, side), "trigger direction changed");
  const slippage = BigInt(expectation.slippageBps);
  check(slippage >= 1n && slippage <= MAX_SLIPPAGE_BPS, "slippage out of range");
  check(limitPrice === triggerLimitPrice(triggerPrice, side, slippage), "limit price differs from trigger and slippage");
  if (expectation.triggerKind !== "stop-entry") check(reduceOnly, "stop-loss and take-profit must be reduce-only");
  if (expectation.amountMicro === undefined) check(reduceOnly, "a whole-position order must be reduce-only");
  else check(abs(baseDelta) === (expectation.amountMicro * BASE) / triggerPrice, "size differs from the amount at the trigger price");
  // services/api orders.ts buildTriggerOrder: a sell may fill up to twice the trigger.
  const feePrice = side === "buy" ? limitPrice : triggerPrice * 2n;
  check(maxFee <= ceilDiv(((abs(baseDelta) * feePrice) / BASE) * ORDER_FEE_BPS, 10_000n), "fee cap changed");
}

/** Checks a TP/SL pair: the legs requested, in order (take-profit, then stop-loss), closing one position with one nonce. */
export function verifyTpslPair(legs: Array<{ type: string; intent: Record<string, unknown> }>, request: { takeProfit?: bigint; stopLoss?: bigint }) {
  const wanted = [request.takeProfit === undefined ? null : "take-profit", request.stopLoss === undefined ? null : "stop-loss"].filter(Boolean);
  check(legs.length === wanted.length && legs.every((leg, index) => leg.type === wanted[index]), "unexpected take-profit/stop-loss legs");
  if (legs.length === 2) {
    check(String(legs[0].intent.baseDelta) === String(legs[1].intent.baseDelta), "take-profit and stop-loss sizes differ");
    check(String(legs[0].intent.nonce) === String(legs[1].intent.nonce), "take-profit and stop-loss nonces differ");
  }
}

/** The integer terms of a firm quote, for a `trade` expectation. Throws when the quote lacks them. */
export function quoteTerms(quote: { baseDelta?: string; worstPrice: string; expectedPrice: string; fee: string; amount?: string; bid: string; ask: string }) {
  return {
    bid: integer(quote.bid, "quote bid"), ask: integer(quote.ask, "quote ask"),
    baseDelta: integer(quote.baseDelta, "quote baseDelta"), worstPrice: integer(quote.worstPrice, "quote worstPrice"),
    expectedPrice: integer(quote.expectedPrice, "quote expectedPrice"), fee: integer(quote.fee, "quote fee"), amount: integer(quote.amount, "quote amount"),
  };
}
