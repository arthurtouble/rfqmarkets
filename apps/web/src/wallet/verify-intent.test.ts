import assert from "node:assert/strict";
import test from "node:test";
import { hashTypedData } from "viem";
import {
  hashIntent, cancelTypes, closeTypes, intentToWire, intentTypes, sessionGrantToWire, sessionGrantTypes,
  triggeredIntentToWire, triggeredIntentTypes, withdrawalToWire, withdrawalTypes, cancelToWire, closeToWire,
  DOMAIN_NAME as SHARED_NAME, DOMAIN_VERSION as SHARED_VERSION, type TradeIntent,
} from "../../../../packages/shared/src/eip712.js";
import { triggerLimitPrice } from "../../../../packages/shared/src/trigger.js";
import type { Prepared } from "../lib/types.js";
import { DOMAIN_NAME, DOMAIN_VERSION, IntentMismatchError, SIGNABLE_TYPES, quoteTerms, verifyPrepared, verifyTpslPair, type Expectation, type SigningContext } from "./verify-intent.js";

const ACCOUNT = "0x1111111111111111111111111111111111111111";
const OTHER = "0x2222222222222222222222222222222222222222";
const CLEARING = "0x3333333333333333333333333333333333333333";
const SESSION = "0x4444444444444444444444444444444444444444";
const CHAIN = 8453;
const context: SigningContext = { account: ACCOUNT, chainId: CHAIN, clearing: CLEARING };
const wireDomain = { name: "RFQ Markets", version: "1", chainId: String(CHAIN), verifyingContract: CLEARING as `0x${string}` };
const E18 = 10n ** 18n;

const prepared = (types: Prepared["types"], intent: Record<string, unknown>): Prepared => ({ domain: { ...wireDomain }, types: structuredClone(types), intent });
const tamper = (base: Prepared, intent: Record<string, unknown>): Prepared => ({ ...base, intent: { ...base.intent, ...intent } });
const refused = (fn: () => unknown, pattern: RegExp) => assert.throws(fn, (error: unknown) => error instanceof IntentMismatchError && pattern.test(error.message));

test("bundled types and domain match the protocol's (packages/shared, contracts/RFQTypes.sol)", () => {
  assert.equal(DOMAIN_NAME, SHARED_NAME);
  assert.equal(DOMAIN_VERSION, SHARED_VERSION);
  assert.deepEqual(SIGNABLE_TYPES, { ...intentTypes, ...triggeredIntentTypes, ...withdrawalTypes, ...cancelTypes, ...closeTypes, ...sessionGrantTypes });
});

// A $10,000 BTC buy at an expected $100,000 with 8 bps tolerance, as services/api builds it.
const expectedPrice = 100_000_000_000n, worstPrice = expectedPrice + 80_000_000n, amount = 10_000_000_000n, fee = 2_000_000n;
// Sized at the mid, as packages/shared constructQuote does.
const bid = 99_900_000_000n, ask = 99_980_000_000n, mid = (bid + ask) / 2n;
const baseDelta = (amount * E18) / mid;
const quote = { quoteId: "q", market: "BTC", side: "buy", amount: amount.toString(), baseDelta: baseDelta.toString(), expectedPrice: expectedPrice.toString(), worstPrice: worstPrice.toString(), fee: fee.toString(), bid: bid.toString(), ask: ask.toString() };
const protectedNotional = (baseDelta * worstPrice) / E18;
const tradeIntent: TradeIntent = {
  account: ACCOUNT, market: 0, baseDelta, limitPrice: worstPrice,
  maxFee: (protectedNotional * fee + amount - 1n) / amount, nonce: 42n, deadline: 1_700_000_030n, reduceOnly: false,
};
const trade = prepared(intentTypes, intentToWire(tradeIntent));
const tradeExpectation: Expectation = { kind: "trade", market: 0, side: "buy", reduceOnly: false, nonce: "42", quote: quoteTerms(quote), amountMicro: amount, slippageBps: 8 };

test("accepts an untampered trade and signs the protocol's digest with the trusted domain", () => {
  const typed = verifyPrepared(trade, "TradeIntent", context, tradeExpectation);
  assert.deepEqual(typed.domain, { name: "RFQ Markets", version: "1", chainId: CHAIN, verifyingContract: CLEARING });
  const sharedDomain = { name: "RFQ Markets", version: "1", chainId: BigInt(CHAIN), verifyingContract: CLEARING };
  assert.equal(hashTypedData(typed as never), hashIntent(sharedDomain, tradeIntent));
  // A forced reduce-only (risk mode) only narrows the order.
  verifyPrepared(tamper(trade, { reduceOnly: true }), "TradeIntent", context, tradeExpectation);
  // A close: no side or amount, any slippage within the API's range.
  verifyPrepared(tamper(trade, { reduceOnly: true }), "TradeIntent", context, { ...tradeExpectation, side: undefined, amountMicro: undefined, slippageBps: undefined, reduceOnly: true });
});

test("refuses a trade signed for another domain, contract, chain or type", () => {
  refused(() => verifyPrepared({ ...trade, domain: { ...wireDomain, verifyingContract: OTHER } }, "TradeIntent", context, tradeExpectation), /wrong settlement contract/);
  refused(() => verifyPrepared({ ...trade, domain: { ...wireDomain, chainId: "1" } }, "TradeIntent", context, tradeExpectation), /wrong chain/);
  refused(() => verifyPrepared({ ...trade, domain: { ...wireDomain, name: "Other" } }, "TradeIntent", context, tradeExpectation), /name or version/);
  refused(() => verifyPrepared({ ...trade, domain: { ...wireDomain, version: "2" } }, "TradeIntent", context, tradeExpectation), /name or version/);
  refused(() => verifyPrepared({ ...trade, domain: { ...wireDomain, salt: "0x01" } as never }, "TradeIntent", context, tradeExpectation), /domain fields/);
  refused(() => verifyPrepared(trade, "TradeIntent", { ...context, clearing: null }, tradeExpectation), /not configured/);
  const reordered = { TradeIntent: [...intentTypes.TradeIntent].reverse() };
  refused(() => verifyPrepared({ ...trade, types: reordered }, "TradeIntent", context, tradeExpectation), /type definition/);
  refused(() => verifyPrepared({ ...trade, types: { ...intentTypes, ...withdrawalTypes } }, "TradeIntent", context, tradeExpectation), /type definition/);
  refused(() => verifyPrepared(trade, "WithdrawalIntent", context, tradeExpectation), /expected a TradeIntent/);
  refused(() => verifyPrepared(tamper(trade, { extra: "1" }), "TradeIntent", context, tradeExpectation), /message fields/);
  refused(() => verifyPrepared(tamper(trade, { account: OTHER }), "TradeIntent", context, tradeExpectation), /another account/);
});

test("refuses a trade whose terms differ from the request or quote", () => {
  refused(() => verifyPrepared(tamper(trade, { market: 1 }), "TradeIntent", context, tradeExpectation), /market changed/);
  refused(() => verifyPrepared(tamper(trade, { baseDelta: (-baseDelta).toString() }), "TradeIntent", context, tradeExpectation), /side changed/);
  refused(() => verifyPrepared(tamper(trade, { baseDelta: (baseDelta * 3n).toString() }), "TradeIntent", context, tradeExpectation), /size differs/);
  refused(() => verifyPrepared(tamper(trade, { limitPrice: (worstPrice + 1n).toString() }), "TradeIntent", context, tradeExpectation), /worse than the quote/);
  refused(() => verifyPrepared(tamper(trade, { maxFee: (tradeIntent.maxFee + 1n).toString() }), "TradeIntent", context, tradeExpectation), /fee cap/);
  refused(() => verifyPrepared(tamper(trade, { nonce: "43" }), "TradeIntent", context, tradeExpectation), /nonce changed/);
  refused(() => verifyPrepared(tamper(trade, { reduceOnly: false }), "TradeIntent", context, { ...tradeExpectation, reduceOnly: true }), /reduce-only was removed/);
  // A quote the server inflated together with the intent: bigger than asked, or a wide worst price.
  const big = quoteTerms({ ...quote, baseDelta: (baseDelta * 2n).toString() });
  refused(() => verifyPrepared(tamper(trade, { baseDelta: (baseDelta * 2n).toString() }), "TradeIntent", context, { ...tradeExpectation, quote: big }), /larger than you asked/);
  const wide = quoteTerms({ ...quote, worstPrice: (expectedPrice * 11n / 10n).toString() });
  refused(() => verifyPrepared(tamper(trade, { limitPrice: (expectedPrice * 11n / 10n).toString() }), "TradeIntent", context, { ...tradeExpectation, quote: wide }), /beyond your slippage/);
  const pricey = quoteTerms({ ...quote, fee: (amount / 10n).toString() });
  refused(() => verifyPrepared(tamper(trade, { maxFee: (amount / 10n).toString() }), "TradeIntent", context, { ...tradeExpectation, quote: pricey }), /unreasonably high/);
  refused(() => quoteTerms({ ...quote, baseDelta: undefined }), /quote baseDelta/);
  // A mid lowered to pass off a bigger size as the amount asked for.
  const lowMid = quoteTerms({ ...quote, bid: (bid / 2n).toString(), ask: (ask / 2n).toString(), baseDelta: (baseDelta * 2n).toString() });
  refused(() => verifyPrepared(tamper(trade, { baseDelta: (baseDelta * 2n).toString() }), "TradeIntent", context, { ...tradeExpectation, quote: lowMid }), /too far from the market/);
  refused(() => verifyPrepared(trade, "TradeIntent", context, { ...tradeExpectation, quote: { ...tradeExpectation.quote, bid: ask + 1n } }), /invalid bid and ask/);
});

test("checks limit orders against the typed limit price and size", () => {
  const limitPrice = 95_000_000_000n, limitAmount = 1_000_000_000n, delta = (limitAmount * E18) / expectedPrice;
  const intent: TradeIntent = { ...tradeIntent, baseDelta: delta, limitPrice, maxFee: (((delta * limitPrice) / E18) * 2n + 9_999n) / 10_000n, nonce: 7n, deadline: 1_700_086_400n };
  const limit = prepared(intentTypes, intentToWire(intent));
  const expected: Expectation = { kind: "limit", market: 0, side: "buy", reduceOnly: false, nonce: "7", amountMicro: limitAmount, limitPrice };
  verifyPrepared(limit, "TradeIntent", context, expected);
  refused(() => verifyPrepared(tamper(limit, { limitPrice: (limitPrice * 2n).toString() }), "TradeIntent", context, expected), /limit price changed/);
  refused(() => verifyPrepared(tamper(limit, { baseDelta: (delta * 5n).toString() }), "TradeIntent", context, expected), /larger than you asked/);
  refused(() => verifyPrepared(tamper(limit, { baseDelta: (-delta).toString() }), "TradeIntent", context, expected), /side changed/);
  refused(() => verifyPrepared(tamper(limit, { reduceOnly: true }), "TradeIntent", context, expected), /reduce-only changed/);
  refused(() => verifyPrepared(tamper(limit, { maxFee: (intent.maxFee * 10n).toString() }), "TradeIntent", context, expected), /fee cap changed/);
});

test("checks trigger orders and TP/SL legs against the requested trigger", () => {
  const triggerPrice = 90_000_000_000n, size = 5n * E18 / 100n, limitPrice = triggerLimitPrice(triggerPrice, "sell", 100n);
  const intent: TradeIntent = { ...tradeIntent, baseDelta: -size, limitPrice, maxFee: (((size * triggerPrice * 2n) / E18) * 2n + 9_999n) / 10_000n, nonce: 9n, reduceOnly: true };
  const leg = prepared(triggeredIntentTypes, triggeredIntentToWire(intent, { triggerPrice, triggerAbove: false }));
  const expected: Expectation = { kind: "trigger", market: 0, triggerKind: "stop-loss", triggerPrice, slippageBps: 100, nonce: "9", reduceOnly: true };
  verifyPrepared(leg, "TriggeredTradeIntent", context, expected);
  refused(() => verifyPrepared(tamper(leg, { triggerPrice: "1" }), "TriggeredTradeIntent", context, expected), /trigger price changed/);
  refused(() => verifyPrepared(tamper(leg, { triggerAbove: true }), "TriggeredTradeIntent", context, expected), /trigger direction/);
  refused(() => verifyPrepared(tamper(leg, { limitPrice: "1" }), "TriggeredTradeIntent", context, expected), /limit price differs/);
  refused(() => verifyPrepared(tamper(leg, { reduceOnly: false }), "TriggeredTradeIntent", context, expected), /reduce-only/);
  refused(() => verifyPrepared(tamper(leg, { maxFee: (intent.maxFee * 2n).toString() }), "TriggeredTradeIntent", context, expected), /fee cap changed/);
  refused(() => verifyPrepared(leg, "TriggeredTradeIntent", context, { ...expected, side: "buy" }), /side changed/);
  // Amount sizing: the size is exactly the amount at the trigger price.
  const amountMicro = 4_500_000_000n;
  verifyPrepared(leg, "TriggeredTradeIntent", context, { ...expected, side: "sell", amountMicro });
  refused(() => verifyPrepared(leg, "TriggeredTradeIntent", context, { ...expected, side: "sell", amountMicro: amountMicro / 2n }), /size differs/);

  const takeProfit = { type: "take-profit", intent: { baseDelta: "-5", nonce: "9" } }, stopLoss = { type: "stop-loss", intent: { baseDelta: "-5", nonce: "9" } };
  verifyTpslPair([takeProfit, stopLoss], { takeProfit: 1n, stopLoss: 1n });
  verifyTpslPair([stopLoss], { stopLoss: 1n });
  refused(() => verifyTpslPair([stopLoss, takeProfit], { takeProfit: 1n, stopLoss: 1n }), /legs/);
  refused(() => verifyTpslPair([takeProfit, stopLoss], { stopLoss: 1n }), /legs/);
  refused(() => verifyTpslPair([takeProfit, { ...stopLoss, intent: { baseDelta: "-6", nonce: "9" } }], { takeProfit: 1n, stopLoss: 1n }), /sizes differ/);
  refused(() => verifyTpslPair([takeProfit, { ...stopLoss, intent: { baseDelta: "-5", nonce: "10" } }], { takeProfit: 1n, stopLoss: 1n }), /nonces differ/);
});

test("withdrawals must pay the signing wallet the requested amount", () => {
  const withdrawal = prepared(withdrawalTypes, withdrawalToWire({ account: ACCOUNT, recipient: ACCOUNT, amount: 250_000_000n, nonce: 5n, deadline: 1_700_000_120n }));
  const expected: Expectation = { kind: "withdraw", amountMicro: 250_000_000n, nonce: "5" };
  verifyPrepared(withdrawal, "WithdrawalIntent", context, expected);
  verifyPrepared(tamper(withdrawal, { recipient: ACCOUNT.toUpperCase().replace("0X", "0x") }), "WithdrawalIntent", context, expected);
  refused(() => verifyPrepared(tamper(withdrawal, { recipient: OTHER }), "WithdrawalIntent", context, expected), /recipient is not your wallet/);
  refused(() => verifyPrepared(tamper(withdrawal, { amount: "250000001" }), "WithdrawalIntent", context, expected), /amount changed/);
  refused(() => verifyPrepared(tamper(withdrawal, { amount: "1e9" }), "WithdrawalIntent", context, expected), /not an integer/);
});

test("session grants must authorize this tab's key with the quick-trading limits", () => {
  const grant = { account: ACCOUNT, session: SESSION, marketMask: 3n, maxTradeNotional: 2_500_000_000n, maxCumulativeNotional: 10_000_000_000n, maxFee: 5_000_000n, validUntil: 1_700_028_800n, nonce: 11n, deadline: 1_700_000_120n };
  const session = prepared(sessionGrantTypes, sessionGrantToWire(grant));
  const expected: Expectation = { kind: "session", session: SESSION, marketMask: 3n, maxTradeNotional: 2_500_000_000n, maxCumulativeNotional: 10_000_000_000n, maxFee: 5_000_000n, durationSeconds: 28_800, nonce: "11" };
  verifyPrepared(session, "SessionGrant", context, expected);
  refused(() => verifyPrepared(tamper(session, { session: OTHER }), "SessionGrant", context, expected), /session key/);
  refused(() => verifyPrepared(tamper(session, { maxTradeNotional: "2500000001" }), "SessionGrant", context, expected), /per-trade limit/);
  refused(() => verifyPrepared(tamper(session, { maxCumulativeNotional: "99999999999" }), "SessionGrant", context, expected), /total limit/);
  refused(() => verifyPrepared(tamper(session, { maxFee: "5000001" }), "SessionGrant", context, expected), /fee limit/);
  refused(() => verifyPrepared(tamper(session, { marketMask: 7 }), "SessionGrant", context, expected), /markets changed/);
  refused(() => verifyPrepared(tamper(session, { validUntil: "1800000000" }), "SessionGrant", context, expected), /longer than requested/);
});

test("cancels and emergency closes name the requested nonce and market", () => {
  const cancel = prepared(cancelTypes, cancelToWire({ account: ACCOUNT, nonce: 12n, deadline: 1n }));
  verifyPrepared(cancel, "CancelIntent", context, { kind: "cancel", nonce: "12" });
  refused(() => verifyPrepared(tamper(cancel, { nonce: "13" }), "CancelIntent", context, { kind: "cancel", nonce: "12" }), /nonce changed/);
  const close = prepared(closeTypes, closeToWire({ account: ACCOUNT, market: 1, nonce: 13n, deadline: 1n }));
  verifyPrepared(close, "CloseIntent", context, { kind: "close", market: 1, nonce: "13" });
  refused(() => verifyPrepared(tamper(close, { market: 0 }), "CloseIntent", context, { kind: "close", market: 1, nonce: "13" }), /market changed/);
  refused(() => verifyPrepared(tamper(close, { account: OTHER }), "CloseIntent", context, { kind: "close", market: 1, nonce: "13" }), /another account/);
});
