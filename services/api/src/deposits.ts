import { randomBytes } from "node:crypto";
import {
  Contract,
  getAddress,
  hexlify,
  parseUnits,
  Signature,
  TypedDataEncoder,
  recoverAddress,
} from "ethers";
import type { FastifyInstance } from "fastify";
import type { ApiContext } from "./context.js";
import { QuoteAdmission } from "./admission.js";
import { publicError } from "./public-error.js";
import { depositExecuteSchema, depositPrepareSchema } from "./schemas.js";
import { settlementEvent } from "./settlement-event.js";

/**
 * Gas-free deposits: the wallet signs native USDC's EIP-3009 `ReceiveWithAuthorization` naming the
 * clearing contract as the receiver, and the API sponsors `depositWithAuthorization`. Only the
 * clearing contract can redeem such an authorization (USDC requires `msg.sender == to`), so a leaked
 * signature can only ever credit the signer's own account.
 */
export const receiveAuthorizationTypes = {
  ReceiveWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
};

/** Authorizations are valid for ten minutes, long enough for a slow wallet prompt. */
const AUTHORIZATION_TTL_SECONDS = 600;
/** Smallest deposit the API pays gas for; smaller ones can still be deposited directly. */
export const MIN_SPONSORED_DEPOSIT = 1_000_000n;

type Authorization = {
  from: string;
  to: string;
  value: bigint;
  validAfter: bigint;
  validBefore: bigint;
  nonce: string;
};

const tokenMetadataAbi = [
  "function name() view returns (string)",
  "function version() view returns (string)",
];

export function registerSponsoredDeposits(app: FastifyInstance, ctx: ApiContext) {
  // Per-account budget: deposits need no prior collateral, so the gate is the rate alone.
  const budget = new QuoteAdmission(
    ctx.options.sponsoredActionRatePerSecond ?? 0.1,
    ctx.options.sponsoredActionBurst ?? 5,
    10_000,
    1_000,
    1_000,
  );
  let domain:
    Promise<{ name: string; version: string; chainId: bigint; verifyingContract: string }> | undefined;
  /** The USDC contract's own EIP-712 domain. Native USDC is version "2"; the local mock has no version(). */
  const tokenDomain = () => {
    const chain = ctx.chain;
    if (!chain) throw new Error("chain unavailable");
    domain ??= (async () => {
      const token = new Contract(chain.config.tokenAddress, tokenMetadataAbi, chain.provider);
      const [name, version] = await Promise.all([
        token.name() as Promise<string>,
        (token.version() as Promise<string>).catch(() => "2"),
      ]);
      return {
        name,
        version,
        chainId: ctx.domain.chainId,
        verifyingContract: getAddress(chain.config.tokenAddress),
      };
    })().catch((error: unknown) => {
      domain = undefined;
      throw error;
    });
    return domain;
  };
  const wire = (authorization: Authorization) => ({
    ...authorization,
    value: authorization.value.toString(),
    validAfter: authorization.validAfter.toString(),
    validBefore: authorization.validBefore.toString(),
  });

  app.post("/v1/deposit/prepare", async (request, reply) => {
    const parsed = depositPrepareSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid deposit request" });
    const value = parseUnits(parsed.data.amount, 6);
    if (value < MIN_SPONSORED_DEPOSIT)
      return reply.code(400).send({ error: "gas-free deposits start at 1 USDC" });
    const chain = ctx.chain;
    if (!chain || !ctx.sender) return reply.code(503).send({ error: "chain unavailable" });
    try {
      const tokenDomainValue = await tokenDomain();
      const authorization: Authorization = {
        from: getAddress(parsed.data.account),
        to: getAddress(chain.config.clearingAddress),
        value,
        validAfter: 0n,
        validBefore: BigInt(Math.floor(Date.now() / 1_000) + AUTHORIZATION_TTL_SECONDS),
        nonce: hexlify(randomBytes(32)),
      };
      return {
        domain: { ...tokenDomainValue, chainId: tokenDomainValue.chainId.toString() },
        types: receiveAuthorizationTypes,
        authorization: wire(authorization),
      };
    } catch (error) {
      return reply.code(503).send({ error: publicError(error, "chain unavailable") });
    }
  });

  app.post("/v1/deposit/execute", async (request, reply) => {
    const parsed = depositExecuteSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid signed deposit" });
    const chain = ctx.chain,
      sender = ctx.sender;
    if (!chain || !sender) return reply.code(503).send({ error: "chain unavailable" });
    const { authorization: input, userSignature } = parsed.data;
    let authorization: Authorization;
    try {
      authorization = {
        from: getAddress(input.from),
        to: getAddress(input.to),
        value: BigInt(input.value),
        validAfter: BigInt(input.validAfter),
        validBefore: BigInt(input.validBefore),
        nonce: input.nonce,
      };
    } catch {
      return reply.code(400).send({ error: "invalid signed deposit" });
    }
    const now = BigInt(Math.floor(Date.now() / 1_000));
    if (
      authorization.to !== getAddress(chain.config.clearingAddress) ||
      authorization.value < MIN_SPONSORED_DEPOSIT ||
      authorization.validBefore <= now ||
      authorization.validBefore > now + BigInt(AUTHORIZATION_TTL_SECONDS) + 60n ||
      authorization.validAfter >= now
    )
      return reply.code(400).send({ error: "invalid signed deposit" });
    // USDC's receiveWithAuthorization takes (v, r, s): an EOA signature. Smart wallets deposit directly.
    if ((userSignature.length - 2) / 2 !== 65)
      return reply.code(400).send({ error: "gas-free deposits need a standard wallet signature" });
    let signature: Signature;
    try {
      const digest = TypedDataEncoder.hash(await tokenDomain(), receiveAuthorizationTypes, authorization);
      signature = Signature.from(userSignature);
      if (getAddress(recoverAddress(digest, signature)) !== authorization.from)
        return reply.code(401).send({ error: "invalid deposit signature" });
    } catch {
      return reply.code(401).send({ error: "invalid deposit signature" });
    }
    if (!budget.allow(authorization.from.toLowerCase()))
      return reply.code(429).send({ error: "sponsored deposit rate limit exceeded" });
    try {
      const data = chain.clearing.interface.encodeFunctionData("depositWithAuthorization", [
        authorization.from,
        authorization.value,
        authorization.validAfter,
        authorization.validBefore,
        authorization.nonce,
        signature.v,
        signature.r,
        signature.s,
      ]);
      // Simulate first: a reverting deposit (short balance, used nonce, first deposit under the
      // floor) would still spend sponsor gas.
      await chain.provider.call({ from: ctx.sponsor?.address, to: chain.config.clearingAddress, data });
      const receipt = await sender.submit(
        `deposit:${authorization.from}:${authorization.nonce}`,
        { to: chain.config.clearingAddress, data },
        { deadline: Number(authorization.validBefore) },
      );
      const credited = await settlementEvent(
        chain.provider,
        chain.config.clearingAddress,
        chain.clearing.interface,
        receipt.hash,
        "Deposited",
        (args) =>
          String(args.account).toLowerCase() === authorization.from.toLowerCase() &&
          BigInt(String(args.amount)) === authorization.value,
      );
      if (!credited) return reply.code(409).send({ error: "deposit not credited" });
      return {
        status: "included",
        transaction: { hash: receipt.hash, blockNumber: receipt.blockNumber },
        collateral: (await chain.clearing.collateralOf(authorization.from)).toString(),
      };
    } catch (error) {
      return reply.code(409).send({ error: publicError(error, "deposit failed") });
    }
  });
}
