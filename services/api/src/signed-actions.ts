import { getAddress, parseUnits, TypedDataEncoder, type TypedDataField } from "ethers";
import type { FastifyInstance } from "fastify";
import type { z } from "zod";
import {
  cancelToWire,
  cancelTypes,
  closeToWire,
  closeTypes,
  sessionGrantToWire,
  sessionGrantTypes,
  withdrawalToWire,
  withdrawalTypes,
  type CancelIntent,
  type CloseIntent,
  type SessionGrant,
  type WithdrawalIntent,
} from "../../../packages/shared/src/eip712.js";
import type { PriceSnapshot } from "../../../packages/shared/src/policy.js";
import { encodeLocalReport, type ChainReader } from "./chain.js";
import type { ApiContext, ApiSender, ChainHandles } from "./context.js";
import type { DevChain } from "./dev-chain.js";
import { Reply } from "./http.js";
import { marketIndex, marketName, unixSeconds } from "./markets.js";
import { validOwnerSignature } from "./owner-signature.js";
import { publicError } from "./public-error.js";
import type { QuoteEngine } from "./quoting.js";
import {
  cancelExecuteSchema,
  cancelPrepareSchema,
  closeExecuteSchema,
  closePrepareSchema,
  sessionExecuteSchema,
  sessionPrepareSchema,
  withdrawalExecuteSchema,
  withdrawalPrepareSchema,
} from "./schemas.js";
import { settlementEvent } from "./settlement-event.js";

/** Owner-signed actions are valid for two minutes after preparation. */
const ACTION_TTL_SECONDS = 120;
const LOCAL_REPORT_TTL_SECONDS = 60;
const CLOSE_GAS_LIMIT = 1_500_000n;

type SignedIntent = { account: string; deadline: bigint };
type Sponsor = ChainHandles & { sender: ApiSender };
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
  return validOwnerSignature(intent.account, digest, signature, ctx.provider);
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
  execute(intent: I, signature: string, sponsor: Sponsor): Promise<unknown>;
  /** Requires collateral and a per-account budget before sponsoring (see admitSponsoredAction). */
  gated?: boolean;
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
      if (!(await verifySignedAction(ctx, action.types, intent, signature)))
        return reply.code(401).send({ error: `invalid ${action.label} signature` });
      const handles = ctx.chain,
        sender = ctx.sender;
      if (!handles || !sender) return reply.code(503).send({ error: "chain unavailable" });
      if (action.gated) {
        const refused = await admitSponsoredAction(ctx, intent.account);
        if (refused) return refused.send(reply);
      }
      const result = await action.execute(intent, signature, { ...handles, sender });
      return result instanceof Reply ? result.send(reply) : result;
    } catch (error) {
      return reply.code(409).send({ error: publicError(error, `${action.label} failed`) });
    }
  });
}

/** Owner withdrawals, nonce cancellation, position close and session-key grants. */
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
    async execute(intent, signature, { sender, clearing, provider, config }) {
      const receipt = await sender.submit(
        `withdraw:${intent.account}:${intent.nonce}`,
        {
          to: config.clearingAddress,
          data: clearing.interface.encodeFunctionData("withdrawWithSignature", [
            intent.account,
            intent.recipient,
            intent.amount,
            intent.nonce,
            intent.deadline,
            signature,
          ]),
        },
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
    async execute(intent, signature, { sender, clearing, config }) {
      const receipt = await sender.submit(
        `cancel:${intent.account}:${intent.nonce}`,
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

  registerSignedAction(app, ctx, chain, {
    path: "/v1/close",
    label: "close",
    types: closeTypes,
    messageKey: "intent",
    prepareSchema: closePrepareSchema,
    executeSchema: closeExecuteSchema,
    build: async (input, chainTime): Promise<CloseIntent> => ({
      account: getAddress(input.account),
      market: marketIndex(input.market),
      nonce: BigInt(input.nonce),
      deadline: await deadline(chainTime),
    }),
    parse: ({ intent }): CloseIntent => ({
      account: getAddress(intent.account),
      market: intent.market,
      nonce: BigInt(intent.nonce),
      deadline: BigInt(intent.deadline),
    }),
    toWire: closeToWire,
    async execute(intent, signature, { sender, clearing, provider, config }) {
      const report = await closeReport(intent),
        value = ctx.devFund ? 0n : BigInt(await (await chain.oracleAdapter()).updateFee(report)),
        data = clearing.interface.encodeFunctionData("closePositionWithSignature", [
          intent.account,
          intent.market,
          intent.nonce,
          intent.deadline,
          report,
          signature,
        ]);
      // Simulate first on live chains: a reverting close would still spend sponsor gas.
      if (!ctx.devFund)
        await provider.call({ from: ctx.sponsor!.address, to: config.clearingAddress, data, value });
      const receipt = await sender.submit(
        `close:${intent.account}:${intent.market}:${intent.nonce}`,
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
    async execute(grant, signature, { sender, clearing, config }) {
      const receipt = await sender.submit(
        `session:${grant.account}:${grant.session}:${grant.nonce}`,
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
}
