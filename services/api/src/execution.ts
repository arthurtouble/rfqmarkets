import { getAddress, keccak256, toUtf8Bytes } from "ethers";
import type { FastifyInstance } from "fastify";
import {
  approvalToWire,
  hashApproval,
  hashIntent,
  intentDigest,
  intentToWire,
  intentTypes,
  recoverDigestSigner,
  triggerToWire,
  type MakerApproval,
  type TradeIntent,
  type Trigger,
} from "../../../packages/shared/src/eip712.js";
import { maskAllows } from "../../../packages/shared/src/clearing-structs.js";
import type { ExposureBook, ExposureMarket } from "../../../packages/shared/src/exposure-admission.js";
import { pendingMakerDebit } from "../../../packages/shared/src/exposure-admission.js";
import { finalizedClock } from "../../../packages/shared/src/finalized-clock.js";
import { finalizeGross, persistGross } from "../../../packages/shared/src/gross-reservation-journal.js";
import type { GrossReservation } from "../../../packages/shared/src/gross-reservations.js";
import { BASE, ceilDiv, formatUsdc, type Quote } from "../../../packages/shared/src/policy.js";
import { triggerReached, triggeredFillDelta } from "../../../packages/shared/src/trigger.js";
import { quoteToWire } from "../../../packages/shared/src/wire.js";
import { APPROVAL_QUORUM, ApprovalCollector, distinctSigners, type ApproverSignature } from "./approvals.js";
import { encodeLocalReport, type ChainMarketState, type ChainReader } from "./chain.js";
import type { ApiContext } from "./context.js";
import type { DevChain } from "./dev-chain.js";
import { Reply } from "./http.js";
import { recordFlowFill } from "./journal.js";
import type { MarketStream } from "./market-stream.js";
import { abs, marketIndex, marketRegistry, unixSeconds } from "./markets.js";
import { validOwnerSignature } from "./owner-signature.js";
import { approverPolicyRejection, publicError } from "./public-error.js";
import type { OracleReport, ProtocolVersions } from "./quote-store.js";
import type { CreatedQuote, QuoteEngine } from "./quoting.js";
import { archiveApiCommitments } from "./recovery.js";
import { approvalRequestSchema, intentRequestSchema, type ApprovalRequest } from "./schemas.js";
import { settlementEvent } from "./settlement-event.js";

/** The wallet signs a short execution interval; oracle proof freshness is bound separately at approval. */
const INTENT_EXECUTION_WINDOW_SECONDS = 30;
/** Maker approvals never outlive this many seconds past the block they were priced at. */
const APPROVAL_TTL_SECONDS = 30;
const LOCAL_REPORT_TTL_SECONDS = 60;
/** Default minimum time left on a proof when the trade is handed to the sender. */
const DEFAULT_MIN_INCLUSION_SECONDS = 4;
/** An approval for a market with outstanding gross risk needs the other market priced this recently. */
const CROSS_MARKET_PRICE_MAX_AGE_SECONDS = 15;
const MAX_RESERVATION_CONFLICTS = 8;
/**
 * Optimistic admissions that lose to another reservation this many times re-price while holding
 * the admission lock, so a burst of simultaneous trades settles in turn instead of starving.
 */
const OPTIMISTIC_RESERVATION_ATTEMPTS = 2;
const COMPLETED_RETENTION_MS = 300_000;
const TRADE_GAS_LIMIT = 2_000_000n;

type CompletedSubmission = {
  account: string;
  nonce: string;
  userSignature: string;
  result: unknown;
  expiresAtMs: number;
};

type GrossSnapshot = {
  blockNumber: number;
  blockTimestamp: number;
  /** Every registered market, by index. */
  books: ExposureBook[];
  states: ExposureMarket[];
  position: { size: bigint; entryPrice: bigint; lastFundingIndex: bigint };
  netLimits: bigint[];
  backing: bigint;
  floor: bigint;
  clock: Awaited<ReturnType<typeof finalizedClock>>;
};

type Admitted = {
  quote: Quote;
  approval: MakerApproval;
  report: string;
  approvals: ApproverSignature[];
  oracleFee: bigint;
  trigger?: Trigger;
};

type TradeTransaction = {
  hash: string;
  blockNumber: number;
  collateral: string;
  position: { size: string; entryPrice: string; lastFundingIndex: string };
};

/** Another admission changed pending inventory after this attempt was priced. */
const RESERVATION_CONFLICT = Symbol("reservation conflict");

function errorText(error: unknown) {
  try {
    return `${String(error)} ${JSON.stringify(error)}`;
  } catch {
    return String(error);
  }
}

/** `StalePrice` reverts (by name or selector) mean the proof aged out and a refresh may succeed. */
function staleOracleFailure(error: unknown) {
  const text = errorText(error).toLowerCase();
  return text.includes("staleprice") || text.includes("0xd7815800") || text.includes("0x45805f5d");
}

function toExposureMarket(value: ChainMarketState): ExposureMarket {
  return {
    aggregateBase: BigInt(value.aggregateBase),
    fundingIndex: BigInt(value.fundingIndex),
    fundingTime: BigInt(value.fundingTime),
    lastPriceTime: BigInt(value.lastPriceTime),
    lastBid: BigInt(value.lastBid),
    lastAsk: BigInt(value.lastAsk),
    enabled: Boolean(value.enabled),
  };
}

function sameSubmission(completed: CompletedSubmission, request: ApprovalRequest) {
  return (
    completed.account.toLowerCase() === request.account.toLowerCase() &&
    completed.nonce === request.nonce &&
    completed.userSignature === request.userSignature
  );
}

const exceedsProtection = (intent: TradeIntent, quote: Quote) =>
  (intent.baseDelta > 0n && quote.expectedPrice > intent.limitPrice) ||
  (intent.baseDelta < 0n && quote.expectedPrice < intent.limitPrice) ||
  quote.fee > intent.maxFee;

/**
 * Market-order execution: bind a quote to a signed intent, durably reserve its risk, collect the
 * approver quorum and submit the sponsored trade.
 */
export class ExecutionService {
  private readonly approvals: ApprovalCollector;
  private readonly active = new Map<string, Promise<void>>();
  private readonly completed = new Map<string, CompletedSubmission>();
  private reservationTail = Promise.resolve();

  constructor(
    private readonly ctx: ApiContext,
    private readonly chain: ChainReader,
    private readonly dev: DevChain,
    private readonly quoting: QuoteEngine,
    private readonly stream: MarketStream,
  ) {
    this.approvals = new ApprovalCollector(
      ctx.options.approvers ?? [],
      ctx.fetchImpl,
      ctx.clearing,
      ctx.options.approverTimeoutMs,
    );
    ctx.onPrune((now) => {
      for (const [id, item] of this.completed) if (item.expiresAtMs <= now) this.completed.delete(id);
    });
  }

  /** Serialize the synchronous admission section; remote work stays outside the lock. */
  private async acquireReservationLock() {
    let release!: () => void;
    const previous = this.reservationTail;
    this.reservationTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    return release;
  }

  private finalizeReservations(block: number, timestamp: number, hash?: string) {
    const { journal, grossReservations, pending } = this.ctx;
    const expired = finalizeGross(journal, grossReservations, block, timestamp, hash, (ids) => {
      if (journal) archiveApiCommitments(journal, ids, Date.now(), false);
    });
    for (const id of expired) pending.delete(id);
    if (expired.length) this.quoting.invalidateMarkets();
  }

  private makeIntent(
    quote: Quote,
    versions: ProtocolVersions,
    account: string,
    nonce: string,
    reduceOnly: boolean,
  ): TradeIntent {
    const prepared = this.ctx.quotes.preparedIntents.get(quote.quoteId);
    if (prepared) return prepared;
    // The user authorizes quantity, price protection, fee and a short execution
    // interval. Oracle proof freshness is independent: a fresh proof is fetched
    // after wallet signing and bound by the approvers immediately before submit.
    // The fee follows the notional at the fill's mid. A buy's protection bounds that; a sell has no
    // upper bound, so its fee cap allows the notional to rise by as much as its protection lets the
    // price fall: a better fill must not fail on a larger fee.
    const protectedNotional = (abs(quote.baseDelta) * quote.worstPrice) / BASE,
      feeNotional =
        quote.baseDelta < 0n
          ? ceilDiv(quote.notional * (2n * quote.expectedPrice - quote.worstPrice), quote.expectedPrice)
          : protectedNotional > quote.notional
            ? protectedNotional
            : quote.notional;
    return {
      account: getAddress(account),
      market: marketIndex(quote.market),
      baseDelta: quote.baseDelta,
      limitPrice: quote.worstPrice,
      maxFee: ceilDiv(feeNotional * quote.fee, quote.notional),
      nonce: BigInt(nonce),
      deadline: BigInt(versions.blockTimestamp + INTENT_EXECUTION_WINDOW_SECONDS),
      reduceOnly: reduceOnly || this.ctx.quotes.forcedReduceOnly.has(quote.quoteId),
    };
  }

  /** Bind a live quote to (account, nonce) and return the typed data the wallet signs. */
  prepare(body: unknown): Reply {
    const parsed = intentRequestSchema.safeParse(body);
    if (!parsed.success) return Reply.error(400, "invalid intent request");
    const { ctx } = this,
      { quoteId, account, nonce, reduceOnly } = parsed.data,
      quote = ctx.quotes.quotes.get(quoteId),
      versions = ctx.quotes.versions.get(quoteId);
    if (!quote || !versions || quote.expiresAtMs <= Date.now()) return Reply.error(409, "quote expired");
    try {
      const requestedAccount = getAddress(account),
        binding = ctx.quotes.bindings.get(quote.quoteId);
      if (binding && (binding.account !== requestedAccount || binding.nonce !== nonce))
        return Reply.error(409, "quote already prepared");
      const intent = this.makeIntent(quote, versions, account, nonce, reduceOnly);
      ctx.quotes.bind(quote.quoteId, intent, nonce);
      return new Reply(200, {
        domain: ctx.wireDomain,
        types: intentTypes,
        intent: intentToWire(intent),
        intentHash: hashIntent(ctx.domain, intent),
      });
    } catch {
      return Reply.error(400, "invalid account or nonce");
    }
  }

  /**
   * Approve and execute a signed intent. Idempotent per quote: an identical retry returns the stored
   * result and a concurrent duplicate waits for the in-flight submission.
   */
  async approve(body: unknown): Promise<Reply> {
    const parsed = approvalRequestSchema.safeParse(body);
    if (!parsed.success) return Reply.error(400, "invalid signed intent");
    const request = parsed.data,
      completed = this.completed.get(request.quoteId);
    if (completed)
      return sameSubmission(completed, request)
        ? new Reply(200, completed.result)
        : Reply.error(409, "quote already submitted");
    const active = this.active.get(request.quoteId);
    if (active) {
      await active;
      const result = this.completed.get(request.quoteId);
      return result && sameSubmission(result, request)
        ? new Reply(200, result.result)
        : Reply.error(409, "quote submission requires reconciliation or retry", { retriable: true });
    }
    if (this.active.size >= this.ctx.maxActiveQuotes) return Reply.error(503, "submission capacity reached");
    let complete!: () => void;
    this.active.set(
      request.quoteId,
      new Promise<void>((resolve) => {
        complete = resolve;
      }),
    );
    try {
      return await this.execute(request);
    } finally {
      this.active.delete(request.quoteId);
      complete();
    }
  }

  /** EOA signature, ERC-1271 wallet, or an active session key whose limits cover this intent. */
  private async authorized(intent: TradeIntent, signature: string, blockNumber: number, trigger?: Trigger) {
    const { domain, provider, clearing } = this.ctx;
    try {
      let signer: string | undefined;
      try {
        signer = recoverDigestSigner(domain, intent, signature, trigger);
      } catch {}
      if (signer === intent.account) return true;
      if (
        await validOwnerSignature(
          intent.account,
          intentDigest(domain, intent, trigger),
          signature,
          provider,
          blockNumber,
        )
      )
        return true;
      if (!clearing || !signer) return false;
      const session = await clearing.sessions(signer, { blockTag: blockNumber });
      return (
        getAddress(session.account) === intent.account &&
        BigInt(session.validUntil) >= intent.deadline &&
        maskAllows(session.marketMask, intent.market) &&
        BigInt(session.maxFee) >= intent.maxFee
      );
    } catch {
      return false;
    }
  }

  private async execute(request: ApprovalRequest): Promise<Reply> {
    const { ctx } = this,
      quote = ctx.quotes.quotes.get(request.quoteId),
      versions = ctx.quotes.versions.get(request.quoteId);
    if (!quote || !versions || quote.expiresAtMs <= Date.now()) return Reply.error(409, "quote expired");
    const binding = ctx.quotes.bindings.get(quote.quoteId);
    let account: string;
    try {
      account = getAddress(request.account);
    } catch {
      return Reply.error(400, "invalid account");
    }
    if (!binding || binding.account !== account || binding.nonce !== request.nonce)
      return Reply.error(409, "quote preparation mismatch");
    const intent = ctx.quotes.preparedIntents.get(quote.quoteId),
      trigger = ctx.quotes.triggers.get(quote.quoteId);
    if (
      !intent ||
      intent.account !== account ||
      intent.nonce !== BigInt(request.nonce) ||
      !(await this.authorized(intent, request.userSignature, versions.blockNumber, trigger))
    )
      return Reply.error(401, "invalid user signature");

    const admitted = await this.admitAndCollect(intent, request.userSignature, quote, trigger);
    if (admitted instanceof Reply) return admitted;
    this.recordApproval(intent, request.userSignature, admitted);
    const transaction = await this.submitTrade(intent, request.userSignature, admitted);
    if (transaction instanceof Reply) return transaction;

    const result = {
      domain: ctx.wireDomain,
      intent: intentToWire(intent),
      ...(trigger ? { trigger: triggerToWire(trigger) } : {}),
      userSignature: request.userSignature,
      approval: approvalToWire(admitted.approval),
      approvals: admitted.approvals,
      quote: quoteToWire(admitted.quote),
      transaction,
    };
    if (this.completed.size >= ctx.maxActiveQuotes)
      this.completed.delete(this.completed.keys().next().value!);
    this.completed.set(admitted.quote.quoteId, {
      account: intent.account,
      nonce: intent.nonce.toString(),
      userSignature: request.userSignature,
      result,
      expiresAtMs: Date.now() + COMPLETED_RETENTION_MS,
    });
    return new Reply(200, result);
  }

  /** The proof to settle with: the oracle report, or a local report on chains without one. */
  private async settlementReport(intent: TradeIntent, quote: Quote, oracleReport?: OracleReport) {
    const report = oracleReport?.report ?? "0x";
    if (!this.ctx.provider || report !== "0x") return report;
    const timestamp = this.ctx.devFund
      ? await this.dev.advanceTime()
      : await this.chain.latestBlockTimestamp();
    return encodeLocalReport(
      intent.market,
      quote.snapshot.bid,
      quote.snapshot.ask,
      timestamp,
      timestamp + LOCAL_REPORT_TTL_SECONDS,
    );
  }

  /** Block-pinned exposure, capital and finality reads for gross admission; null if the block is missing. */
  private async readGrossSnapshot(intent: TradeIntent): Promise<GrossSnapshot | null> {
    const clearing = this.ctx.clearing!,
      provider = this.ctx.provider!,
      blockNumber = await this.chain.blockNumber(),
      block = await provider.getBlock(blockNumber);
    if (!block) return null;
    const blockTag = { blockTag: blockNumber };
    // Gross, net and stress admission covers every market the chain has at this block.
    await marketRegistry.ensureCount(await clearing.marketCount(blockTag));
    const indexes = marketRegistry.all().map((market) => market.index);
    const [books, rawStates, limitWords, positionRaw, backing, floor, clock] = await Promise.all([
      Promise.all(indexes.map((index) => clearing.exposureState(index, blockTag))),
      Promise.all(indexes.map((index) => clearing.markets(index, blockTag))),
      Promise.all(indexes.map((index) => clearing.marketLimitWord(index, blockTag))),
      clearing.positionOf(intent.account, intent.market, blockTag),
      clearing.makerBacking(blockTag),
      clearing.baseRiskCapitalTarget(blockTag),
      finalizedClock(provider, blockNumber, block.timestamp),
    ]);
    return {
      blockNumber,
      blockTimestamp: block.timestamp,
      books: books.map((book) => ({
        longBase: BigInt(book.longBase),
        shortBase: BigInt(book.shortBase),
        limits: BigInt(book.limits),
        ready: Boolean(book.ready),
      })),
      states: rawStates.map(toExposureMarket),
      position: {
        size: BigInt(positionRaw.size),
        entryPrice: BigInt(positionRaw.entryPrice),
        lastFundingIndex: BigInt(positionRaw.lastFundingIndex),
      },
      netLimits: limitWords.map((word) => BigInt(word)),
      backing: BigInt(backing),
      floor: BigInt(floor),
      clock,
    };
  }

  /**
   * Re-price against a fresh settlement proof, durably reserve the risk, then collect the quorum and
   * simulate. Retries once when the proof runs out of inclusion budget or goes stale in simulation.
   */
  private async admitAndCollect(
    intent: TradeIntent,
    userSignature: string,
    original: Quote,
    trigger?: Trigger,
  ): Promise<Reply | Admitted> {
    const { ctx } = this,
      intentHash = intentDigest(ctx.domain, intent, trigger),
      minimumBudget = ctx.options.minSettlementInclusionSeconds ?? DEFAULT_MIN_INCLUSION_SECONDS,
      // A triggered quote prices the fill (a reduce-only trigger clamped to the position); the
      // contract re-derives that clamp, so it is re-checked against the gross snapshot below.
      fill: TradeIntent = trigger ? { ...intent, baseDelta: original.baseDelta } : intent;
    let quote = original;
    // Optimistic reads precede a synchronous durable admission section. Remote
    // quorum and simulation run after publication and outside the lock.
    for (let attempt = 0, conflicts = 0; attempt < 2; attempt++) {
      // After repeated conflicts the lock is taken before re-pricing (queued, FIFO) and handed to the
      // admission section below; `finally` releases it on every path that leaves before then.
      let queued =
        conflicts >= OPTIMISTIC_RESERVATION_ATTEMPTS ? await this.acquireReservationLock() : undefined;
      try {
        let refreshed: CreatedQuote;
        try {
          refreshed = await this.quoting.createQuote(
            { market: quote.market, side: quote.side, amount: formatUsdc(quote.notional) },
            {
              persist: false,
              exactBaseDelta: fill.baseDelta,
              reductionAccount: intent.account,
              excludeReservation: original.quoteId,
            },
          );
        } catch (error) {
          return Reply.error(503, publicError(error, "fresh settlement price unavailable"));
        }
        if (exceedsProtection(intent, refreshed.quote))
          return Reply.error(409, "price moved beyond signed protection");
        // The settlement report carries this snapshot's touch; the contract checks its mid.
        if (trigger && !triggerReached(refreshed.quote.snapshot.bid, refreshed.quote.snapshot.ask, trigger))
          return Reply.error(409, "trigger no longer reached");
        quote = { ...refreshed.quote, quoteId: original.quoteId };
        const { versions, oracleReport, reservationRevision } = refreshed;
        ctx.prune();
        const reportExpiry = oracleReport?.validUntil ?? versions.blockTimestamp + APPROVAL_TTL_SECONDS,
          approvalDeadline = BigInt(
            Math.min(Number(intent.deadline), versions.blockTimestamp + APPROVAL_TTL_SECONDS, reportExpiry),
          );
        if (Number(approvalDeadline) <= versions.blockTimestamp)
          return Reply.error(503, "fresh settlement proof lacks inclusion time", { retriable: true });
        const report = await this.settlementReport(intent, quote, oracleReport);
        const oracleReportHash =
          report === "0x"
            ? keccak256(
                toUtf8Bytes(
                  JSON.stringify({
                    market: quote.market,
                    bid: quote.snapshot.bid.toString(),
                    ask: quote.snapshot.ask.toString(),
                    observedAtMs: quote.snapshot.observedAtMs,
                  }),
                ),
              )
            : keccak256(report);
        const approval: MakerApproval = {
          intentHash,
          executionPrice: quote.expectedPrice,
          impactCharge: quote.impactCharge,
          fee: quote.fee,
          oracleReportHash,
          deadline: approvalDeadline,
          leaderEpoch: versions.leaderEpoch,
          signerSetVersion: versions.signerSetVersion,
          policyVersion: versions.policyVersion,
        };
        const digest = hashApproval(ctx.domain, approval),
          approverPayload = {
            domain: ctx.wireDomain,
            intent: intentToWire(intent),
            userSignature,
            approval: approvalToWire(approval),
            quote: quoteToWire(quote),
            ...(trigger ? { trigger: triggerToWire(trigger) } : {}),
            report,
            oracleAgeMs: Math.max(0, Date.now() - quote.snapshot.observedAtMs),
          };
        let grossSnapshot: GrossSnapshot | undefined;
        if (ctx.clearing && ctx.provider) {
          const snapshot = await this.readGrossSnapshot(intent);
          if (!snapshot) return Reply.error(503, "gross reservation snapshot unavailable");
          if (trigger && triggeredFillDelta(intent, snapshot.position.size) !== fill.baseDelta)
            return Reply.error(409, "position changed since the trigger was priced");
          grossSnapshot = snapshot;
        }
        const release = queued ?? (await this.acquireReservationLock());
        queued = undefined;
        let reserved: Reply | typeof RESERVATION_CONFLICT | undefined;
        try {
          reserved = this.reserveLocked({
            intent,
            fill,
            quote,
            approval,
            digest,
            approverPayload,
            userSignature,
            reservationRevision,
            grossSnapshot,
          });
        } finally {
          release();
        }
        if (reserved === RESERVATION_CONFLICT) {
          if (++conflicts >= MAX_RESERVATION_CONFLICTS)
            return Reply.error(503, "admission inventory changed; request a fresh quote", {
              retriable: true,
            });
          attempt--;
          continue;
        }
        if (reserved) return reserved;

        const responses = await this.approvals.collect(digest, approverPayload),
          distinct = distinctSigners(responses);
        if (distinct.size < APPROVAL_QUORUM) {
          const policy = approverPolicyRejection(responses, this.approvals.size, APPROVAL_QUORUM);
          if (policy) return Reply.error(409, policy);
          return Reply.error(503, "approver quorum unavailable", {
            details:
              ctx.devFund || process.env.NODE_ENV === "test"
                ? responses.filter((item) => item.status === "rejected").map((item) => String(item.reason))
                : undefined,
          });
        }
        const selected = [...distinct.values()].slice(0, APPROVAL_QUORUM);
        const currentChainTime = ctx.provider ? await this.chain.chainTimestamp() : versions.blockTimestamp;
        if (Number(approval.deadline) - currentChainTime < minimumBudget) {
          if (attempt === 1)
            return Reply.error(503, "settlement proof lacks safe inclusion budget", { retriable: true });
          continue;
        }
        let oracleFee = 0n;
        const chain = ctx.chain;
        if (chain && ctx.sponsor && !ctx.devFund) {
          try {
            const adapter = await this.chain.oracleAdapter();
            oracleFee = BigInt(await adapter.updateFee(report).catch(() => 0n));
            await chain.provider.call({
              from: ctx.sponsor.address,
              to: chain.config.clearingAddress,
              data: this.executeTradeData(intent, approval, report, userSignature, selected, trigger),
              value: oracleFee,
            });
          } catch (error) {
            if (attempt === 0 && staleOracleFailure(error)) continue;
            return Reply.error(409, "settlement simulation failed", {
              retriable: staleOracleFailure(error),
              details: process.env.NODE_ENV === "test" ? errorText(error) : undefined,
            });
          }
        }
        return { quote, approval, report, approvals: selected, oracleFee, trigger };
      } finally {
        queued?.();
      }
    }
    // Every path through the final attempt returns; a conflict retries the same attempt.
    throw new Error("approval admission did not converge");
  }

  /** Synchronous admission: no await may separate the checks from the durable reservation. */
  private reserveLocked(input: {
    intent: TradeIntent;
    /** The trade the approval prices; equal to `intent` except for a clamped reduce-only trigger. */
    fill: TradeIntent;
    quote: Quote;
    approval: MakerApproval;
    digest: string;
    approverPayload: unknown;
    userSignature: string;
    reservationRevision: number;
    grossSnapshot?: GrossSnapshot;
  }): Reply | typeof RESERVATION_CONFLICT | undefined {
    const { ctx } = this,
      { journal, grossReservations, pending } = ctx,
      { intent, fill, quote, approval, grossSnapshot } = input;
    ctx.prune();
    if (pending.revision !== input.reservationRevision) return RESERVATION_CONFLICT;
    let grossItem: GrossReservation = {
      market: intent.market,
      baseDelta: fill.baseDelta,
      reduceOnly: intent.reduceOnly,
      deadline: Number(approval.deadline),
      makerDebit: 2n * BigInt(quote.notional),
    };
    if (grossSnapshot) {
      const { blockNumber, blockTimestamp, books, states, position, netLimits, backing, floor, clock } =
        grossSnapshot;
      if (clock) this.finalizeReservations(clock.block, clock.timestamp, clock.hash);
      if (intent.market >= states.length) return Reply.error(409, "unknown market");
      const asks = states.map((state) => BigInt(state.lastAsk));
      asks[intent.market] = quote.snapshot.ask;
      const priorGross = grossReservations.bounds(quote.quoteId, states.length);
      for (const [other, otherState] of states.entries()) {
        if (other === intent.market) continue;
        if (
          priorGross[other].longBase + priorGross[other].shortBase > 0n &&
          (Number(otherState.lastPriceTime) === 0 ||
            blockTimestamp - Number(otherState.lastPriceTime) > CROSS_MARKET_PRICE_MAX_AGE_SECONDS)
        )
          return Reply.error(503, "outstanding gross risk requires fresh cross-market price");
      }
      const net = states.map(
        (state) =>
          (BigInt(state.aggregateBase) * (BigInt(state.lastBid) + BigInt(state.lastAsk))) / 2n / BASE,
      );
      const capitalMarket = {
        ...states[intent.market],
        lastBid: quote.snapshot.bid,
        lastAsk: quote.snapshot.ask,
        lastPriceTime: BigInt(unixSeconds(quote.snapshot.observedAtMs)),
      };
      grossItem = {
        ...grossItem,
        makerDebit: pendingMakerDebit({
          position,
          market: capitalMarket,
          delta: fill.baseDelta,
          executionPrice: approval.executionPrice,
          timestamp: BigInt(blockTimestamp),
          deadline: approval.deadline,
          netLimit: netLimits[intent.market],
        }),
      };
      const existingGross = grossReservations.get(quote.quoteId);
      if (existingGross && existingGross.makerDebit !== grossItem.makerDebit)
        return Reply.error(503, "approval risk changed; request a fresh quote", { retriable: true });
      if (
        !grossReservations.admit(quote.quoteId, grossItem, books, asks, blockNumber, {
          net,
          netLimits,
          backing,
          floor,
        })
      )
        return Reply.error(409, "outstanding approvals exceed gross, net, stress, side or capital capacity");
    } else {
      const timestamp = unixSeconds();
      this.finalizeReservations(timestamp, timestamp);
    }
    if (!grossReservations.get(quote.quoteId) && grossReservations.size >= ctx.maxActiveQuotes)
      return Reply.error(503, "gross reservation capacity reached");
    // Persist and reserve before signatures can escape, even if the quorum
    // response is lost. Failed admission retains conservative risk to expiry.
    journal?.exec("BEGIN IMMEDIATE");
    try {
      journal
        ?.prepare("INSERT OR IGNORE INTO approval_artifacts VALUES(?,?,?,?)")
        .run(input.digest, quote.quoteId, JSON.stringify(input.approverPayload), Date.now());
      journal
        ?.prepare(
          "INSERT INTO commitments VALUES (?, ?, ?, ?, 'reserved', ?, ?, ?, NULL, ?) ON CONFLICT(quote_id) DO UPDATE SET expires_ms=MAX(expires_ms,excluded.expires_ms),intent_json=excluded.intent_json,user_signature=excluded.user_signature,approval_json=excluded.approval_json,updated_ms=excluded.updated_ms",
        )
        .run(
          quote.quoteId,
          quote.market,
          quote.delta.toString(),
          Number(intent.deadline) * 1_000,
          JSON.stringify(intentToWire(intent)),
          input.userSignature,
          JSON.stringify(approvalToWire(approval)),
          Date.now(),
        );
      if (journal) persistGross(journal, quote.quoteId, grossItem);
      journal?.exec("COMMIT");
    } catch (error) {
      journal?.exec("ROLLBACK");
      throw error;
    }
    grossReservations.reserve(quote.quoteId, grossItem);
    pending.add(quote.quoteId, {
      market: quote.market,
      delta: quote.delta,
      expiresAtMs: Number(intent.deadline) * 1_000,
    });
    this.quoting.invalidateMarkets();
    return undefined;
  }

  /** Record the quorum-approved commitment and make sure its exposure is priced. */
  private recordApproval(intent: TradeIntent, userSignature: string, { quote, approval }: Admitted) {
    const { journal, pending } = this.ctx;
    journal
      ?.prepare(
        "INSERT INTO commitments VALUES (?, ?, ?, ?, 'reserved', ?, ?, ?, NULL, ?) ON CONFLICT(quote_id) DO UPDATE SET status='reserved', intent_json=excluded.intent_json, user_signature=excluded.user_signature, approval_json=excluded.approval_json, updated_ms=excluded.updated_ms",
      )
      .run(
        quote.quoteId,
        quote.market,
        quote.delta.toString(),
        Number(intent.deadline) * 1_000,
        JSON.stringify(intentToWire(intent)),
        userSignature,
        JSON.stringify(approvalToWire(approval)),
        Date.now(),
      );
    if (!pending.has(quote.quoteId)) {
      pending.add(quote.quoteId, {
        market: quote.market,
        delta: quote.delta,
        expiresAtMs: Number(approval.deadline) * 1_000,
      });
      this.quoting.invalidateMarkets();
      this.stream.schedulePublish();
    }
    journal
      ?.prepare("UPDATE commitments SET status='approved', updated_ms=? WHERE quote_id=?")
      .run(Date.now(), quote.quoteId);
  }

  private executeTradeData(
    intent: TradeIntent,
    approval: MakerApproval,
    report: string,
    userSignature: string,
    approvals: ApproverSignature[],
    trigger?: Trigger,
  ) {
    const signatures = [userSignature, approvals[0].signature, approvals[1].signature];
    return trigger
      ? this.ctx.clearing!.interface.encodeFunctionData("executeTriggeredTrade", [
          intent,
          trigger,
          approval,
          report,
          ...signatures,
        ])
      : this.ctx.clearing!.interface.encodeFunctionData("executeTrade", [
          intent,
          approval,
          report,
          ...signatures,
        ]);
  }

  /** Sponsor the trade and confirm its settlement event; without a chain the approval is the result. */
  private async submitTrade(
    intent: TradeIntent,
    userSignature: string,
    admitted: Admitted,
  ): Promise<Reply | TradeTransaction | undefined> {
    const { ctx } = this,
      { chain, sender, journal } = ctx,
      { quote, approval, report, approvals, oracleFee, trigger } = admitted;
    if (!chain || !sender) return undefined;
    const { clearing, provider, config } = chain;
    try {
      await this.dev.autofund(intent.account, quote.quoteId);
      const receipt = await sender.submit(`trade:${quote.quoteId}`, {
        to: config.clearingAddress,
        data: this.executeTradeData(intent, approval, report, userSignature, approvals, trigger),
        value: oracleFee,
        gasLimit: TRADE_GAS_LIMIT,
      });
      this.chain.invalidateQuoteSnapshot();
      this.quoting.invalidateMarkets();
      journal
        ?.prepare("UPDATE commitments SET status='submitted', tx_hash=?, updated_ms=? WHERE quote_id=?")
        .run(receipt.hash, Date.now(), quote.quoteId);
      const intentHash = approval.intentHash.toLowerCase();
      if (
        !(await settlementEvent(
          provider,
          config.clearingAddress,
          clearing.interface,
          receipt.hash,
          "TradeExecuted",
          (args) => String(args.intentHash).toLowerCase() === intentHash,
        ))
      ) {
        journal
          ?.prepare("UPDATE commitments SET status='ambiguous',updated_ms=? WHERE quote_id=?")
          .run(Date.now(), quote.quoteId);
        return new Reply(409, {
          status: (await clearing.resolutionRequired()) ? "resolution_required" : "ambiguous",
          error: "transaction included without the authorized trade; reconcile before retrying",
          transaction: { hash: receipt.hash, blockNumber: receipt.blockNumber },
        });
      }
      const collateral = await clearing.collateralOf(intent.account);
      const position = await clearing.positionOf(intent.account, intent.market);
      ctx.notifyPositionChange(intent.account, quote.market);
      journal
        ?.prepare("UPDATE commitments SET status='included', updated_ms=? WHERE quote_id=?")
        .run(Date.now(), quote.quoteId);
      if (ctx.pending.delete(quote.quoteId))
        ctx.settled[quote.market] = (ctx.settled[quote.market] ?? 0n) + quote.delta;
      const fill = {
        market: quote.market,
        side: quote.side,
        price: quote.expectedPrice,
        notional: quote.notional,
        atMs: Date.now(),
      };
      ctx.flowRisk.record(quote.market, fill);
      recordFlowFill(journal, quote.quoteId, fill);
      this.quoting.invalidateMarkets();
      this.stream.schedulePublish();
      return {
        hash: receipt.hash,
        blockNumber: receipt.blockNumber,
        collateral: collateral.toString(),
        position: {
          size: position.size.toString(),
          entryPrice: position.entryPrice.toString(),
          lastFundingIndex: position.lastFundingIndex.toString(),
        },
      };
    } catch (error) {
      return Reply.error(409, publicError(error, "chain submission failed"));
    }
  }

  register(app: FastifyInstance) {
    app.post("/v1/prepare", async (request, reply) => this.prepare(request.body).send(reply));
    app.post("/v1/approve", async (request, reply) => (await this.approve(request.body)).send(reply));
  }
}
