import type { ApproverPayload } from "../../../packages/shared/src/approver-payload.js";
import { finalizedClock } from "../../../packages/shared/src/finalized-clock.js";
import type { GrossReservation } from "../../../packages/shared/src/gross-reservations.js";
import { hashApproval, intentDigest } from "../../../packages/shared/src/eip712.js";
import { triggerReached, triggeredFillDelta } from "../../../packages/shared/src/trigger.js";
import {
  marketIndex,
  marketName,
  marketRegistry,
  type MarketIndex,
} from "../../../packages/shared/src/markets.js";
import { BASE, abs } from "../../../packages/shared/src/numeric.js";
import type { OracleObservation } from "../../../packages/shared/src/oracle-report.js";
import { checkUserAuthorization, checkUserSignature, recoverSigner } from "./authorization.js";
import { checkChainPolicy, readChainState, verifySignedReport, type ChainClients } from "./chain-state.js";
import {
  checkDomain,
  checkEnvelopeConsistency,
  checkVersions,
  checkWallClockExpiry,
  decodeEnvelope,
  type Envelope,
} from "./envelope.js";
import {
  buildGrossContext,
  checkChainTimeExpiry,
  checkCrossMarketFreshness,
  checkExposure,
  checkImpact,
  checkMarketEnabled,
  checkTradeLimit,
  markedMarkets,
  type GrossContext,
} from "./exposure-policy.js";
import { checkHedgeRisk, fetchHedgeRisk } from "./hedge-policy.js";
import type { ApprovalJournal } from "./journal.js";
import {
  checkChainTimeOracle,
  checkOracleWidth,
  checkSubmittedReport,
  checkVerifiedObservation,
  safetyPrices,
} from "./oracle-policy.js";
import { DEFAULT_MAX_FUTURE_SECONDS, type ApproverOptions } from "./options.js";
import { checkPricePolicy, checkQuoteModel, checkQuoteSpread } from "./pricing-policy.js";
import { reject, type Rejection } from "./rejection.js";

/** Upper bound on live gross reservations held in memory. */
export const MAX_GROSS_RESERVATIONS = 50_000;

export interface ApproverContext {
  options: ApproverOptions;
  signer: string;
  /** Raw secp256k1 signature over an EIP-712 digest. Must be synchronous. */
  sign(digest: string): string;
  journal: ApprovalJournal;
  /** Absent only in the development mode without an RPC; most chain checks are then skipped. */
  chain?: ChainClients;
}

export interface SignedApproval {
  digest: string;
  signer: string;
  signature: string;
}

type Check = Rejection | undefined;

/**
 * Validate a leader envelope against this approver's own view of the world and,
 * when every check passes, sign and durably journal the maker approval.
 */
export async function approve(
  context: ApproverContext,
  input: ApproverPayload,
): Promise<Rejection | SignedApproval> {
  const { options, chain } = context,
    maxFutureSeconds = options.maxFutureSeconds ?? DEFAULT_MAX_FUTURE_SECONDS;
  const envelope = decodeEnvelope(input);
  if (!envelope) return reject("invalid typed data", 400);
  // `fill` is the trade the approval prices: the signed intent, or a clamped reduce-only trigger.
  const { domain, intent, approval, trigger, fill } = envelope;
  // A market added on chain since the last registry refresh: refresh once before judging it.
  if (!marketRegistry.has(input.quote.market) || !marketRegistry.hasIndex(intent.market))
    await marketRegistry.ensureCount(intent.market + 1).catch(() => {});
  if (!marketRegistry.has(input.quote.market) || !marketRegistry.hasIndex(intent.market))
    return reject("unknown market");
  const nowMs = Date.now();
  const offChain: Check =
    checkDomain(domain, {
      chainId: options.expectedChainId,
      verifyingContract: options.expectedVerifyingContract,
    }) ??
    (chain ? undefined : checkWallClockExpiry(intent, approval, nowMs, maxFutureSeconds)) ??
    // Without a chain the position, and so a reduce-only clamp, cannot be verified: fail closed.
    (chain || fill.baseDelta === intent.baseDelta ? undefined : reject("triggered fill unverifiable")) ??
    checkVersions(approval, {
      epoch: options.expectedEpoch,
      policyVersion: options.expectedPolicyVersion,
      signerSetVersion: options.expectedSignerSetVersion,
    }) ??
    checkQuoteModel(input.quote.spread, options.expectedQuoteModelVersion) ??
    checkQuoteSpread(input.quote, fill.baseDelta.toString()) ??
    checkEnvelopeConsistency(input.quote, fill, approval);
  if (offChain) return offChain;

  const market = marketIndex(input.quote.market),
    intentHash = intentDigest(domain, intent, trigger),
    intentSigner = recoverSigner(domain, intent, input.userSignature, trigger);
  const signatureCheck: Check =
    checkUserSignature({
      approval,
      intentHash,
      intentSigner,
      account: intent.account,
      requireAccountSigner: !chain,
    }) ??
    checkPricePolicy({
      quote: input.quote,
      intent: fill,
      approval,
      nowMs,
      maxFutureSeconds,
      capNotional: !chain,
    });
  if (signatureCheck) return signatureCheck;

  const submitted = checkSubmittedReport({
    report: input.report,
    oracleReportHash: approval.oracleReportHash,
    market,
    quote: input.quote,
    oracle: options,
    nowMs,
    maxFutureSeconds,
    checkWallClock: !chain,
  });
  if (submitted.rejection) return submitted.rejection;
  // Off chain the trigger is checked on the submitted report (or the quote's touch without one);
  // with a chain `chainChecks` checks it on the observation the adapter would actually settle.
  if (!chain && trigger) {
    const prices = safetyPrices(submitted.observation, input.quote);
    if (!triggerReached(prices.bid, prices.ask, trigger)) return reject("trigger not reached");
  }

  let grossContext: GrossContext | undefined;
  if (chain) {
    try {
      const result = await chainChecks(context, chain, {
        input,
        envelope,
        market,
        intentHash,
        intentSigner,
        observation: submitted.observation,
        nowMs,
        maxFutureSeconds,
      });
      if ("status" in result) return result;
      grossContext = result;
    } catch (error) {
      return reject("independent chain read unavailable", 503, {
        detail: process.env.NODE_ENV === "test" ? String(error) : undefined,
      });
    }
  }
  return signAndCommit(context, input, envelope, nowMs, grossContext);
}

/** Checks that need this approver's own chain reads. Throws on any read failure. */
async function chainChecks(
  context: ApproverContext,
  chain: ChainClients,
  request: {
    input: ApproverPayload;
    envelope: Envelope;
    market: MarketIndex;
    intentHash: string;
    intentSigner: string | undefined;
    observation: OracleObservation | undefined;
    nowMs: number;
    maxFutureSeconds: number;
  },
): Promise<Rejection | GrossContext> {
  const { options, journal } = context,
    { input, envelope, market, nowMs, maxFutureSeconds } = request,
    { domain, approval, trigger } = envelope;
  // Economics and exposure are judged on the fill; authorization and expiry on the signed intent.
  const intent = envelope.fill;
  const read = await readChainState(chain, {
    chainId: domain.chainId,
    signer: context.signer,
    intent: envelope.intent,
    intentHash: request.intentHash,
    intentSigner: request.intentSigner,
    userSignature: input.userSignature,
  });
  if ("rejection" in read) return read.rejection;
  const snapshot = read.snapshot,
    selected = snapshot.markets[market],
    limitWord = snapshot.limitWords[market],
    notional = BigInt(input.quote.amount),
    executionNotional = (abs(intent.baseDelta) * approval.executionPrice) / BASE;
  const policy = checkChainPolicy(snapshot, approval);
  if (policy) return policy;
  // The contract clamps a reduce-only trigger to the position at execution; the approval must price
  // exactly that fill at this approver's own read of the position.
  if (trigger && triggeredFillDelta(envelope.intent, snapshot.position.size) !== intent.baseDelta)
    return reject("triggered fill does not match position");

  let observation = request.observation;
  if (options.oracleMode === "signed") {
    try {
      observation = await verifySignedReport(
        chain,
        input.report,
        domain.verifyingContract,
        snapshot.blockNumber,
        market,
      );
    } catch {
      return reject("oracle report rejected");
    }
    const verified = checkVerifiedObservation(observation, market);
    if (verified) return verified;
  }

  const accountChecks: Check =
    checkTradeLimit({
      positionSize: snapshot.position.size,
      delta: intent.baseDelta,
      notional,
      executionNotional,
      limitWord,
    }) ??
    checkChainTimeExpiry(intent, approval, snapshot.blockTimestamp, maxFutureSeconds) ??
    checkUserAuthorization({
      signingAccount: snapshot.signingAccount,
      accountSignatureValid: snapshot.accountSignatureValid,
      session: snapshot.session,
      intent,
      fee: approval.fee,
      notional,
    }) ??
    checkMarketEnabled(selected, snapshot.position.size, intent.baseDelta);
  if (accountChecks) return accountChecks;

  if (options.hedgeRisk) {
    let risk;
    try {
      risk = await fetchHedgeRisk(options.hedgeRisk, options.fetchImpl);
    } catch {
      return reject("hedge health unavailable", 503);
    }
    const hedge = checkHedgeRisk({
      risk,
      market: marketName(market),
      nowMs,
      maxAgeMs: options.hedgeRisk.maxAgeMs,
      aggregateBase: selected.aggregateBase,
      positionSize: snapshot.position.size,
      delta: intent.baseDelta,
      limitWord,
      executionNotional,
      spread: input.quote.spread,
    });
    if (hedge) return hedge;
  }

  const prices = safetyPrices(observation, input.quote);
  const oracle: Check =
    checkChainTimeOracle(observation, snapshot.blockTimestamp, maxFutureSeconds) ??
    checkOracleWidth(prices) ??
    (trigger && !triggerReached(prices.bid, prices.ask, trigger) ? reject("trigger not reached") : undefined);
  if (oracle) return oracle;

  const markets = markedMarkets(
    snapshot,
    market,
    prices,
    observation?.observedAt ?? BigInt(Math.floor(input.quote.observedAtMs / 1000)),
  );
  const exposure = checkExposure({ snapshot, markets, market, intent, approval });
  if (exposure) return exposure;

  const clock = await finalizedClock(
    chain.provider,
    snapshot.blockNumber,
    snapshot.blockTimestamp,
    chain.secondaryProvider,
  );
  const gross = journal.gross;
  if (clock && clock.block >= gross.finalizedBlock && clock.timestamp >= gross.finalizedTimestamp)
    journal.finalize(clock.block, clock.timestamp, clock.hash);

  const freshness = checkCrossMarketFreshness(gross, approval.intentHash.toLowerCase(), snapshot, market);
  if (freshness) return freshness;
  const grossContext = buildGrossContext({
    snapshot,
    markets,
    market,
    position: snapshot.position,
    intent,
    approval,
  });
  return checkImpact({ markets, market, prices, intent, approval }) ?? grossContext;
}

/**
 * Gross admission, signing and the durable commit. Synchronous on purpose: no
 * await between journal admission, signature creation and durable commit.
 */
function signAndCommit(
  context: ApproverContext,
  input: ApproverPayload,
  { domain, fill: intent, approval }: Envelope,
  nowMs: number,
  grossContext: GrossContext | undefined,
): Rejection | SignedApproval {
  const { journal } = context,
    gross = journal.gross;
  const grossId = approval.intentHash.toLowerCase(),
    grossItem: GrossReservation = {
      market: intent.market as MarketIndex,
      baseDelta: intent.baseDelta,
      reduceOnly: intent.reduceOnly,
      deadline: Number(approval.deadline),
      makerDebit: grossContext?.makerDebit ?? 2n * BigInt(input.quote.amount),
    };
  if (grossContext) {
    if (
      !gross.admit(
        grossId,
        grossItem,
        grossContext.books,
        grossContext.asks,
        grossContext.block,
        grossContext.risk,
      )
    )
      return reject("independent outstanding gross, net, stress or capital capacity exceeded");
  } else {
    const timestamp = Math.floor(Date.now() / 1000);
    journal.finalize(timestamp, timestamp);
  }
  if (journal.incompleteLegacy) return reject("legacy approval recovery is incomplete", 503);
  if (!gross.get(grossId) && gross.size >= MAX_GROSS_RESERVATIONS)
    return reject("gross reservation capacity reached", 503);
  const digest = hashApproval(domain, approval);
  const existing = journal.signatureFor(digest);
  if (existing) return { digest, signer: context.signer, signature: existing };
  const signature = context.sign(digest);
  journal.commit({
    digest,
    epoch: Number(approval.leaderEpoch),
    expiryMs: Number(approval.deadline) * 1_000,
    signature,
    createdMs: nowMs,
    payload: input,
    grossId,
    grossItem,
  });
  return { digest, signer: context.signer, signature };
}
