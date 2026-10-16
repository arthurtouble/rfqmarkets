import { getAddress, parseUnits, recoverAddress, TypedDataEncoder, type TypedDataField } from "ethers";
import type { FastifyInstance } from "fastify";
import type { z } from "zod";
import {
  cancelToWire,
  cancelTypes,
  closeToWire,
  closeTypes,
  isolatedMarginToWire,
  isolatedMarginTypes,
  sessionGrantToWire,
  sessionGrantTypes,
  sessionRevokeToWire,
  sessionRevokeTypes,
  withdrawalToWire,
  withdrawalTypes,
  type CancelIntent,
  type CloseIntent,
  type IsolatedMarginIntent,
  type SessionGrant,
  type SessionRevoke,
  type WithdrawalIntent,
} from "../../../packages/shared/src/eip712.js";
import { maskAllows } from "../../../packages/shared/src/clearing-structs.js";
import { ceilDiv } from "../../../packages/shared/src/numeric.js";
import type { PriceSnapshot } from "../../../packages/shared/src/policy.js";
import { encodeLocalReport, type ChainReader } from "./chain.js";
import type { ApiContext, ApiSender, ChainHandles } from "./context.js";
import type { DevChain } from "./dev-chain.js";
import { Reply } from "./http.js";
import { marketIndex, marketName, unixSeconds } from "./markets.js";
import { isolatedAccountAddress, type IsolatedOwnerReader } from "../../../packages/shared/src/isolated.js";
import { signingAccount, validOwnerSignature } from "./owner-signature.js";
import { publicError } from "./public-error.js";
import type { QuoteEngine } from "./quoting.js";
import {
  cancelExecuteSchema,
  cancelPrepareSchema,
  closeExecuteSchema,
  closePrepareSchema,
  isolatedMarginExecuteSchema,
  isolatedMarginPrepareSchema,
  sessionExecuteSchema,
  sessionPrepareSchema,
  sessionRevokeExecuteSchema,
  sessionRevokePrepareSchema,
  withdrawalExecuteSchema,
  withdrawalPrepareSchema,
} from "./schemas.js";
import { settlementEvent } from "./settlement-event.js";

/** Owner-signed actions are valid for two minutes after preparation. */
const ACTION_TTL_SECONDS = 120;
const LOCAL_REPORT_TTL_SECONDS = 60;
const CLOSE_GAS_LIMIT = 1_500_000n;
/** Room a prepared close leaves, by default, between the price when it is signed and the price it exits at. */
const CLOSE_SLIPPAGE_BPS = 200n;

type SignedIntent = { account: string; deadline: bigint };
/**
 * `operationId` keys the sponsored transaction in the sender's journal. `resumed` is true when that journal
 * already holds it (a client retrying an action that was sent): the action then skips its simulation, and the
 * request skips its admission gates, so the retry gets the stored outcome instead of a fresh refusal.
 */
type Sponsor = ChainHandles & { sender: ApiSender; operationId: string; resumed: boolean };
type Receipt = Awaited<ReturnType<ApiSender["submit"]>>;

const transactionOf = (receipt: Receipt) => ({ hash: receipt.hash, blockNumber: receipt.blockNumber });

/** An unexpired intent signed by its account, as an EOA or an ERC-1271 wallet. */
export async function verifySignedAction(
  ctx: ApiContext,
  types: Record<string, TypedDataField[]>,
  intent: SignedIntent,
  signature: string,
) {
  if (Number(intent.deadline) * 1_000 <= Date.now()) return false;
  const digest = TypedDataEncoder.hash(ctx.domain, types, intent);
  return validOwnerSignature(
    await signingAccount(ctx.clearing as IsolatedOwnerReader | undefined, intent.account),
    digest,
    signature,
    ctx.provider,
  );
}

/** The on-chain grant of a session key (RFQClearing.sessions). */
type SessionView = { account: string; validUntil: bigint; marketMask: bigint; maxTradeNotional: bigint };

/**
 * An unexpired intent signed by a live session key of its account whose grant `allows` it. Only actions the
 * contract also accepts from session keys opt in (see SignedAction.sessionAllows).
 */
async function verifySessionSignedAction<I extends SignedIntent>(
  ctx: ApiContext,
  types: Record<string, TypedDataField[]>,
  intent: I,
  signature: string,
  allows: (intent: I, session: SessionView) => boolean,
) {
  const clearing = ctx.clearing as { sessions(session: string): Promise<SessionView> } | undefined;
  if (!clearing || Number(intent.deadline) * 1_000 <= Date.now()) return false;
  try {
    const signer = recoverAddress(TypedDataEncoder.hash(ctx.domain, types, intent), signature);
    const session = await clearing.sessions(signer);
    return (
      getAddress(session.account) === getAddress(intent.account) &&
      BigInt(session.validUntil) >= intent.deadline &&
      allows(intent, session)
    );
  } catch {
    return false;
  }
}

/**
 * Gate for sponsored actions that the contract accepts from any signer, funded or not (nonce
 * cancellation, session grants): the account must hold collateral, and each account has its own
 * small budget so one funded wallet cannot monopolize the single-lane sponsor or its daily budget.
 * Called only after the owner signature verified, so nobody can spend another account's budget.
 */
export async function admitSponsoredAction(ctx: ApiContext, account: string): Promise<Reply | undefined> {
  const { clearing } = ctx;
  if (!clearing) return Reply.error(503, "chain unavailable");
  let collateral: bigint;
  try {
    collateral = BigInt(await clearing.collateralOf(account));
  } catch {
    return Reply.error(503, "chain unavailable");
  }
  if (collateral <= 0n) return Reply.error(409, "deposit collateral before using sponsored actions");
  // Charged only for actions that would be sponsored; refused ones are bounded by the public write budget.
  if (!ctx.sponsoredActions.allow(account.toLowerCase()))
    return Reply.error(429, "sponsored action rate limit exceeded");
  return undefined;
}

/**
 * Gate for isolated margin moves. A move is a routine step of every isolated (Home) trade, often signed by a
 * session key, so it does not spend the scarce sponsored-action budget; it has its own, looser per-account
 * bucket instead, and the account it draws from must hold collateral (an unfunded wallet's move would revert).
 */
export async function admitIsolatedMargin(
  ctx: ApiContext,
  intent: { account: string; market: number; amount: bigint },
): Promise<Reply | undefined> {
  const { clearing } = ctx;
  if (!clearing) return Reply.error(503, "chain unavailable");
  const source = intent.amount > 0n ? intent.account : isolatedAccountAddress(intent.account, intent.market);
  let collateral: bigint;
  try {
    collateral = BigInt(await clearing.collateralOf(source));
  } catch {
    return Reply.error(503, "chain unavailable");
  }
  if (collateral <= 0n) return Reply.error(409, "deposit collateral before using sponsored actions");
  if (!ctx.isolatedMarginActions.allow(intent.account.toLowerCase()))
    return Reply.error(429, "sponsored action rate limit exceeded");
  return undefined;
}

/**
 * A two-step owner action: `prepare` returns EIP-712 typed data for the wallet, `execute` verifies the
 * signature and sponsors the matching clearing call.
 */
interface SignedAction<P extends z.ZodTypeAny, E extends z.ZodTypeAny, I extends SignedIntent> {
  path: string;
  /** Noun used in error messages: "invalid <label> request", "<label> failed". */
  label: string;
  types: Record<string, TypedDataField[]>;
  /** Key holding the typed-data message in both the prepare response and the execute body. */
  messageKey: "intent" | "grant";
  prepareSchema: P;
  executeSchema: E;
  /**
   * Build the unsigned message. Validation errors reject the request as invalid; `chainTime` is read
   * after validation and its failure is reported as a chain outage.
   */
  build(input: z.infer<P>, chainTime: () => Promise<number>): Promise<I>;
  parse(input: z.infer<E>): I;
  toWire(intent: I): unknown;
  /** The sender journal key of the action's sponsored transaction. */
  operationId(intent: I): string;
  /** `bySession` is true when a session key signed (see `sessionAllows`) rather than the owner. */
  execute(intent: I, signature: string, sponsor: Sponsor, bySession: boolean): Promise<unknown>;
  /** Also accept a signature from a session key of the account whose on-chain grant allows this intent. */
  sessionAllows?(intent: I, session: SessionView): boolean;
  /** Requires collateral and a per-account budget before sponsoring (see admitSponsoredAction). */
  gated?: boolean;
  /** An action-specific admission check, run after the signature verified and before sponsoring. */
  admit?(intent: I): Promise<Reply | undefined>;
}

function registerSignedAction<P extends z.ZodTypeAny, E extends z.ZodTypeAny, I extends SignedIntent>(
  app: FastifyInstance,
  ctx: ApiContext,
  chain: ChainReader,
  action: SignedAction<P, E, I>,
) {
  app.post(`${action.path}/prepare`, async (request, reply) => {
    const invalid = { error: `invalid ${action.label} request` };
    const parsed = action.prepareSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send(invalid);
    let chainFailed = false;
    // Deadlines start from the later of chain and wall time: execute checks them against wall time, and
    // an idle local chain's latest block can be minutes old, which would expire the intent on arrival.
    const chainTime = () =>
      chain.chainTimestamp().then(
        (timestamp) => Math.max(timestamp, unixSeconds()),
        (error: unknown) => {
          chainFailed = true;
          throw error;
        },
      );
    let intent: I;
    try {
      intent = await action.build(parsed.data, chainTime);
    } catch (error) {
      return chainFailed
        ? reply.code(503).send({ error: publicError(error, "chain unavailable") })
        : reply.code(400).send(invalid);
    }
    return { domain: ctx.wireDomain, types: action.types, [action.messageKey]: action.toWire(intent) };
  });

  app.post(`${action.path}/execute`, async (request, reply) => {
    const parsed = action.executeSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: `invalid signed ${action.label}` });
    const signature: string = parsed.data.userSignature;
    try {
      const intent = action.parse(parsed.data);
      const byOwner = await verifySignedAction(ctx, action.types, intent, signature);
      const bySession =
        !byOwner &&
        !!action.sessionAllows &&
        (await verifySessionSignedAction(ctx, action.types, intent, signature, action.sessionAllows));
      if (!byOwner && !bySession) return reply.code(401).send({ error: `invalid ${action.label} signature` });
      const handles = ctx.chain,
        sender = ctx.sender;
      if (!handles || !sender) return reply.code(503).send({ error: "chain unavailable" });
      const operationId = action.operationId(intent),
        resumed = sender.hasOperation?.(operationId) ?? false;
      if (!resumed) {
        if (action.gated) {
          const refused = await admitSponsoredAction(ctx, intent.account);
          if (refused) return refused.send(reply);
        }
        const refused = await action.admit?.(intent);
        if (refused) return refused.send(reply);
      }
      const result = await action.execute(
        intent,
        signature,
        { ...handles, sender, operationId, resumed },
        bySession,
      );
      // Quotes pin a block; the next one must see this action (a new session key or isolated account).
      chain.invalidateQuoteSnapshot();
      return result instanceof Reply ? result.send(reply) : result;
    } catch (error) {
      return reply.code(409).send({ error: publicError(error, `${action.label} failed`) });
    }
  });
}

/** Owner withdrawals, isolated margin moves, nonce cancellation, position close and session-key grants. */
export function registerSignedActions(
  app: FastifyInstance,
  ctx: ApiContext,
  chain: ChainReader,
  dev: DevChain,
  quoting: QuoteEngine,
) {
  const deadline = async (chainTime: () => Promise<number>) =>
    BigInt((await chainTime()) + ACTION_TTL_SECONDS);

  registerSignedAction(app, ctx, chain, {
    path: "/v1/withdraw",
    label: "withdrawal",
    types: withdrawalTypes,
    messageKey: "intent",
    prepareSchema: withdrawalPrepareSchema,
    executeSchema: withdrawalExecuteSchema,
    build: async (input, chainTime): Promise<WithdrawalIntent> => {
      const account = getAddress(input.account),
        recipient = getAddress(input.recipient ?? input.account),
        amount = parseUnits(input.amount, 6);
      if (amount <= 0n) throw new Error("invalid withdrawal amount");
      return { account, recipient, amount, nonce: BigInt(input.nonce), deadline: await deadline(chainTime) };
    },
    parse: ({ intent }): WithdrawalIntent => ({
      account: getAddress(intent.account),
      recipient: getAddress(intent.recipient),
      amount: BigInt(intent.amount),
      nonce: BigInt(intent.nonce),
      deadline: BigInt(intent.deadline),
    }),
    toWire: withdrawalToWire,
    // An unfunded account's withdrawal can only revert; each account also has a sponsored budget.
    gated: true,
    operationId: (intent) => `withdraw:${intent.account}:${intent.nonce}`,
    async execute(intent, signature, { sender, clearing, provider, config, operationId, resumed }) {
      // The contract needs fresh prices for markets the account holds. Trades keep them fresh; between
      // trades they lapse after 15 seconds. Best effort: a paused venue still lets the withdrawal try.
      await quoting.refreshOpenMarketPrices().catch(() => undefined);
      const data = clearing.interface.encodeFunctionData("withdrawWithSignature", [
        intent.account,
        intent.recipient,
        intent.amount,
        intent.nonce,
        intent.deadline,
        signature,
      ]);
      // Simulate first on live chains: a reverting withdrawal would still spend sponsor gas.
      if (!ctx.devFund && !resumed)
        await provider.call({ from: ctx.sponsor!.address, to: config.clearingAddress, data });
      const receipt = await sender.submit(
        operationId,
        { to: config.clearingAddress, data },
        { deadline: Number(intent.deadline) },
      );
      const paid = await settlementEvent(
        provider,
        config.clearingAddress,
        clearing.interface,
        receipt.hash,
        "Withdrawn",
        (args) =>
          String(args.account).toLowerCase() === intent.account.toLowerCase() &&
          BigInt(String(args.amount)) === intent.amount,
      );
      if (!paid)
        return new Reply(409, {
          status: "resolution_required",
          error: "withdrawal not paid; inspect resolution state",
          transaction: transactionOf(receipt),
        });
      return {
        status: "included",
        transaction: transactionOf(receipt),
        collateral: (await clearing.collateralOf(intent.account)).toString(),
      };
    },
  });

  registerSignedAction(app, ctx, chain, {
    path: "/v1/isolated/margin",
    label: "isolated margin",
    types: isolatedMarginTypes,
    messageKey: "intent",
    prepareSchema: isolatedMarginPrepareSchema,
    executeSchema: isolatedMarginExecuteSchema,
    build: async (input, chainTime): Promise<IsolatedMarginIntent> => {
      const amount = parseUnits(input.amount, 6);
      if (amount <= 0n) throw new Error("invalid isolated margin amount");
      return {
        account: getAddress(input.account),
        market: marketIndex(input.market),
        amount: input.direction === "add" ? amount : -amount,
        nonce: BigInt(input.nonce),
        deadline: await deadline(chainTime),
      };
    },
    parse: ({ intent }): IsolatedMarginIntent => ({
      account: getAddress(intent.account),
      market: intent.market,
      amount: BigInt(intent.amount),
      nonce: BigInt(intent.nonce),
      deadline: BigInt(intent.deadline),
    }),
    toWire: isolatedMarginToWire,
    // A session key may move margin for one-tap trades: in its markets, adding at most its per-trade cap.
    sessionAllows: (intent, session) =>
      maskAllows(session.marketMask, intent.market) && intent.amount <= BigInt(session.maxTradeNotional),
    admit: (intent) => admitIsolatedMargin(ctx, intent),
    operationId: (intent) => `isolated:${intent.account}:${intent.nonce}`,
    async execute(
      intent,
      signature,
      { sender, clearing, provider, config, operationId, resumed },
      bySession,
    ) {
      const method = bySession ? "moveIsolatedMarginWithSessionSignature" : "moveIsolatedMarginWithSignature";
      const data = clearing.interface.encodeFunctionData(method, [
        intent.account,
        intent.market,
        intent.amount,
        intent.nonce,
        intent.deadline,
        signature,
      ]);
      // Simulate first on live chains: a reverting move would still spend sponsor gas.
      if (!ctx.devFund && !resumed)
        await provider.call({ from: ctx.sponsor!.address, to: config.clearingAddress, data });
      const receipt = await sender.submit(
        operationId,
        { to: config.clearingAddress, data },
        { deadline: Number(intent.deadline) },
      );
      const isolated = isolatedAccountAddress(intent.account, intent.market);
      const [collateral, isolatedCollateral] = await Promise.all([
        clearing.collateralOf(intent.account),
        clearing.collateralOf(isolated),
      ]);
      ctx.notifyPositionChange(intent.account, marketName(intent.market));
      return {
        status: "included",
        transaction: transactionOf(receipt),
        collateral: collateral.toString(),
        isolated: {
          account: isolated,
          market: marketName(intent.market),
          collateral: isolatedCollateral.toString(),
        },
      };
    },
  });

  registerSignedAction(app, ctx, chain, {
    path: "/v1/nonce/cancel",
    label: "cancellation",
    types: cancelTypes,
    messageKey: "intent",
    prepareSchema: cancelPrepareSchema,
    executeSchema: cancelExecuteSchema,
    build: async (input, chainTime): Promise<CancelIntent> => ({
      account: getAddress(input.account),
      nonce: BigInt(input.nonce),
      deadline: await deadline(chainTime),
    }),
    parse: ({ intent }): CancelIntent => ({
      account: getAddress(intent.account),
      nonce: BigInt(intent.nonce),
      deadline: BigInt(intent.deadline),
    }),
    toWire: cancelToWire,
    gated: true,
    operationId: (intent) => `cancel:${intent.account}:${intent.nonce}`,
    async execute(intent, signature, { sender, clearing, config, operationId }) {
      const receipt = await sender.submit(
        operationId,
        {
          to: config.clearingAddress,
          data: clearing.interface.encodeFunctionData("cancelNonceWithSignature", [
            intent.account,
            intent.nonce,
            intent.deadline,
            signature,
          ]),
        },
        { deadline: Number(intent.deadline) },
      );
      return { status: "included", transaction: transactionOf(receipt) };
    },
  });

  /** The proof a sponsored close settles against; local chains get a locally signed report. */
  async function closeReport(intent: CloseIntent) {
    const market = marketName(intent.market);
    let observed: PriceSnapshot | undefined;
    if (ctx.options.oracleSource) {
      const observation = await quoting.settlementOracle(market);
      ctx.prices[market] = observed = observation.snapshot;
      if (!ctx.devFund) return observation.report;
    }
    const timestamp = ctx.devFund ? await dev.advanceTime() : await chain.latestBlockTimestamp(),
      price = observed ?? ctx.prices[market];
    if (!price) throw new Error(`no price for ${market}`);
    return encodeLocalReport(
      intent.market,
      price.bid,
      price.ask,
      timestamp,
      timestamp + LOCAL_REPORT_TTL_SECONDS,
    );
  }

  /** The worst exit price a close accepts when the caller names none: the current side less the slippage room. */
  async function defaultCloseLimit(account: string, market: number) {
    if (!ctx.chain) return 0n;
    const size = BigInt((await ctx.chain.clearing.positionOf(account, market)).size);
    if (size === 0n) return 0n;
    const name = marketName(market),
      price = ctx.options.oracleSource ? (await quoting.settlementOracle(name)).snapshot : ctx.prices[name];
    if (!price) throw new Error(`no price for ${name}`);
    return size > 0n
      ? (price.bid * (10_000n - CLOSE_SLIPPAGE_BPS)) / 10_000n
      : ceilDiv(price.ask * (10_000n + CLOSE_SLIPPAGE_BPS), 10_000n);
  }

  registerSignedAction(app, ctx, chain, {
    path: "/v1/close",
    label: "close",
    types: closeTypes,
    messageKey: "intent",
    prepareSchema: closePrepareSchema,
    executeSchema: closeExecuteSchema,
    build: async (input, chainTime): Promise<CloseIntent> => {
      const account = getAddress(input.account),
        market = marketIndex(input.market),
        limitPrice =
          input.limitPrice === undefined
            ? await defaultCloseLimit(account, market)
            : parseUnits(input.limitPrice, 6);
      return { account, market, limitPrice, nonce: BigInt(input.nonce), deadline: await deadline(chainTime) };
    },
    parse: ({ intent }): CloseIntent => ({
      account: getAddress(intent.account),
      market: intent.market,
      limitPrice: BigInt(intent.limitPrice),
      nonce: BigInt(intent.nonce),
      deadline: BigInt(intent.deadline),
    }),
    toWire: closeToWire,
    operationId: (intent) => `close:${intent.account}:${intent.market}:${intent.nonce}`,
    async execute(intent, signature, { sender, clearing, provider, config, operationId, resumed }) {
      const report = await closeReport(intent),
        value = ctx.devFund ? 0n : BigInt(await (await chain.oracleAdapter()).updateFee(report)),
        data = clearing.interface.encodeFunctionData("closePositionWithSignature", [
          intent.account,
          intent.market,
          intent.limitPrice,
          intent.nonce,
          intent.deadline,
          report,
          signature,
        ]);
      // Simulate first on live chains: a reverting close would still spend sponsor gas.
      if (!ctx.devFund && !resumed)
        await provider.call({ from: ctx.sponsor!.address, to: config.clearingAddress, data, value });
      const receipt = await sender.submit(
        operationId,
        {
          to: config.clearingAddress,
          data,
          value,
          gasLimit: CLOSE_GAS_LIMIT,
        },
        { deadline: Number(intent.deadline) },
      );
      const closed = await settlementEvent(
        provider,
        config.clearingAddress,
        clearing.interface,
        receipt.hash,
        "PositionClosed",
        (args) =>
          String(args.account).toLowerCase() === intent.account.toLowerCase() &&
          Number(args.market) === intent.market,
      );
      if (!closed)
        return new Reply(409, {
          status: "resolution_required",
          error: "position not closed; inspect resolution state",
          transaction: transactionOf(receipt),
        });
      const position = await clearing.positionOf(intent.account, intent.market);
      ctx.notifyPositionChange(intent.account, marketName(intent.market));
      return {
        status: "included",
        transaction: transactionOf(receipt),
        position: { size: position.size.toString(), entryPrice: position.entryPrice.toString() },
      };
    },
  });

  registerSignedAction(app, ctx, chain, {
    path: "/v1/session",
    label: "session",
    types: sessionGrantTypes,
    messageKey: "grant",
    prepareSchema: sessionPrepareSchema,
    executeSchema: sessionExecuteSchema,
    build: async (input, chainTime): Promise<SessionGrant> => {
      const account = getAddress(input.account),
        session = getAddress(input.session),
        now = await chainTime(),
        grant: SessionGrant = {
          account,
          session,
          marketMask: input.marketMask,
          maxTradeNotional: parseUnits(input.maxTradeAmount, 6),
          maxCumulativeNotional: parseUnits(input.maxCumulativeAmount, 6),
          maxFee: parseUnits(input.maxFee, 6),
          validUntil: BigInt(now + input.durationSeconds),
          nonce: BigInt(input.nonce),
          deadline: BigInt(now + ACTION_TTL_SECONDS),
        };
      if (grant.maxTradeNotional <= 0n || grant.maxTradeNotional > grant.maxCumulativeNotional)
        throw new Error("invalid session limits");
      return grant;
    },
    parse: ({ grant }): SessionGrant => ({
      ...grant,
      account: getAddress(grant.account),
      session: getAddress(grant.session),
      marketMask: BigInt(grant.marketMask),
      maxTradeNotional: BigInt(grant.maxTradeNotional),
      maxCumulativeNotional: BigInt(grant.maxCumulativeNotional),
      maxFee: BigInt(grant.maxFee),
      validUntil: BigInt(grant.validUntil),
      nonce: BigInt(grant.nonce),
      deadline: BigInt(grant.deadline),
    }),
    toWire: sessionGrantToWire,
    gated: true,
    operationId: (grant) => `session:${grant.account}:${grant.session}:${grant.nonce}`,
    async execute(grant, signature, { sender, clearing, config, operationId }) {
      const receipt = await sender.submit(
        operationId,
        {
          to: config.clearingAddress,
          data: clearing.interface.encodeFunctionData("grantSessionWithSignature", [grant, signature]),
        },
        { deadline: Number(grant.deadline) },
      );
      return {
        status: "active",
        session: grant.session,
        validUntil: grant.validUntil.toString(),
        transaction: transactionOf(receipt),
      };
    },
  });
  // Turning one-tap trading off costs the owner no gas: the API relays the owner's signed revocation.
  registerSignedAction(app, ctx, chain, {
    path: "/v1/session/revoke",
    label: "session revocation",
    types: sessionRevokeTypes,
    messageKey: "intent",
    prepareSchema: sessionRevokePrepareSchema,
    executeSchema: sessionRevokeExecuteSchema,
    build: async (input, chainTime): Promise<SessionRevoke> => ({
      account: getAddress(input.account),
      session: getAddress(input.session),
      nonce: BigInt(input.nonce),
      deadline: await deadline(chainTime),
    }),
    parse: ({ intent }): SessionRevoke => ({
      account: getAddress(intent.account),
      session: getAddress(intent.session),
      nonce: BigInt(intent.nonce),
      deadline: BigInt(intent.deadline),
    }),
    toWire: sessionRevokeToWire,
    gated: true,
    operationId: (intent) => `session-revoke:${intent.account}:${intent.session}:${intent.nonce}`,
    async execute(intent, signature, { sender, clearing, config, operationId }) {
      const receipt = await sender.submit(
        operationId,
        {
          to: config.clearingAddress,
          data: clearing.interface.encodeFunctionData("revokeSessionWithSignature", [
            intent.account,
            intent.session,
            intent.nonce,
            intent.deadline,
            signature,
          ]),
        },
        { deadline: Number(intent.deadline) },
      );
      return { status: "revoked", session: intent.session, transaction: transactionOf(receipt) };
    },
  });
}
