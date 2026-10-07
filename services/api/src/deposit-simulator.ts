import { getAddress, keccak256, parseUnits, toUtf8Bytes } from "ethers";
import type { FastifyInstance } from "fastify";
import {
  depositToWire,
  depositTypes,
  recoverDepositSigner,
  type DepositIntent,
} from "../../../packages/shared/src/eip712.js";
import type { ApiContext } from "./context.js";
import type { DevChain } from "./dev-chain.js";
import { unixSeconds } from "./markets.js";
import { publicError } from "./public-error.js";
import { depositExecuteSchema, depositQuoteSchema } from "./schemas.js";

type SourceToken = "USDC" | "USDT" | "ETH";
type DepositStatus = "quoted" | "authorized" | "deposited";
type DepositRoute = {
  intent: DepositIntent;
  fromToken: SourceToken;
  amount: string;
  expectedUsdc: bigint;
  status: DepositStatus;
  destinationTxHash?: string;
  transaction?: { hash: string; blockNumber: number; collateral: string };
};

/** The local simulator prices ETH at a fixed 2,500 USDC and charges a 30 bps route fee. */
const SIMULATED_ETH_PRICE_USDC = 2_500n;
const ROUTE_FEE_BPS = 30n;
const ROUTE_SLIPPAGE_BPS = 50n;
const MINIMUM_DEPOSIT = 10n * 1_000_000n;
const ROUTE_TTL_SECONDS = 120;

/**
 * Cross-chain deposit routes backed by a local simulator. Quotes work everywhere; execution mints mock
 * USDC and therefore requires the local development chain.
 */
export class DepositSimulator {
  private readonly routes = new Map<string, DepositRoute>();

  constructor(
    private readonly ctx: ApiContext,
    private readonly dev: DevChain,
  ) {
    this.restore();
  }

  private restore() {
    const rows =
      this.ctx.journal
        ?.prepare(
          "SELECT route_id, account, from_chain, from_token, source_amount, expected_usdc, minimum_usdc, deadline, nonce, status, destination_tx FROM deposit_routes WHERE status = 'deposited' OR (status IN ('quoted','authorized') AND deadline > ?)",
        )
        .all(unixSeconds()) ?? [];
    for (const row of rows) {
      const item = row as {
        route_id: string;
        account: string;
        from_chain: string;
        from_token: SourceToken;
        source_amount: string;
        expected_usdc: string;
        minimum_usdc: string;
        deadline: number;
        nonce: string;
        status: DepositStatus;
        destination_tx: string | null;
      };
      this.routes.set(item.route_id, {
        intent: {
          account: item.account,
          routeId: item.route_id,
          sourceChainId: BigInt(item.from_chain),
          sourceTokenHash: keccak256(toUtf8Bytes(item.from_token)),
          sourceAmount: BigInt(item.source_amount),
          minimumUsdc: BigInt(item.minimum_usdc),
          deadline: BigInt(item.deadline),
          nonce: BigInt(item.nonce),
        },
        fromToken: item.from_token,
        amount: item.source_amount,
        expectedUsdc: BigInt(item.expected_usdc),
        status: item.status,
        destinationTxHash: item.destination_tx ?? undefined,
      });
    }
  }

  private setStatus(routeId: string, route: DepositRoute, status: DepositStatus) {
    route.status = status;
    this.ctx.journal
      ?.prepare("UPDATE deposit_routes SET status=?, updated_ms=? WHERE route_id=?")
      .run(status, Date.now(), routeId);
  }

  private deposited(routeId: string, route: DepositRoute) {
    return {
      status: "deposited",
      routeId,
      expectedUsdc: route.expectedUsdc.toString(),
      transaction: route.transaction,
    };
  }

  register(app: FastifyInstance) {
    const { ctx } = this;
    app.post("/v1/deposit/quote", async (request, reply) => {
      const parsed = depositQuoteSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: "invalid deposit request" });
      const { fromChainId, fromToken, amount } = parsed.data;
      try {
        const account = getAddress(parsed.data.account),
          sourceAmount = parseUnits(amount, fromToken === "ETH" ? 18 : 6);
        if (sourceAmount <= 0n) throw new Error();
        const grossUsdc =
          fromToken === "ETH"
            ? (sourceAmount * SIMULATED_ETH_PRICE_USDC * 1_000_000n) / 10n ** 18n
            : sourceAmount;
        const expectedUsdc = (grossUsdc * (10_000n - ROUTE_FEE_BPS)) / 10_000n,
          minimumUsdc = (expectedUsdc * (10_000n - ROUTE_SLIPPAGE_BPS)) / 10_000n;
        if (minimumUsdc < MINIMUM_DEPOSIT) throw new Error("minimum deposit is 10 USDC");
        const routeId = keccak256(toUtf8Bytes(crypto.randomUUID())),
          deadline = BigInt(unixSeconds() + ROUTE_TTL_SECONDS),
          nonce = BigInt(`0x${crypto.randomUUID().replaceAll("-", "")}`);
        const intent: DepositIntent = {
          account,
          routeId,
          sourceChainId: BigInt(fromChainId),
          sourceTokenHash: keccak256(toUtf8Bytes(fromToken)),
          sourceAmount,
          minimumUsdc,
          deadline,
          nonce,
        };
        this.routes.set(routeId, { intent, fromToken, amount, expectedUsdc, status: "quoted" });
        ctx.journal
          ?.prepare("INSERT INTO deposit_routes VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'quoted', NULL, ?)")
          .run(
            routeId,
            account,
            fromChainId.toString(),
            fromToken,
            sourceAmount.toString(),
            expectedUsdc.toString(),
            minimumUsdc.toString(),
            Number(deadline),
            nonce.toString(),
            Date.now(),
          );
        return {
          provider: "local-simulator",
          routeId,
          fromChainId,
          fromToken,
          amount,
          expectedUsdc: expectedUsdc.toString(),
          minimumUsdc: minimumUsdc.toString(),
          estimatedSeconds: 2,
          domain: ctx.wireDomain,
          types: depositTypes,
          intent: depositToWire(intent),
        };
      } catch (error) {
        return reply.code(409).send({ error: publicError(error, "deposit route rejected") });
      }
    });

    app.post("/v1/deposit/execute", async (request, reply) => {
      const parsed = depositExecuteSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: "invalid deposit execution" });
      const { routeId, userSignature } = parsed.data,
        route = this.routes.get(routeId);
      if (!route) return reply.code(404).send({ error: "deposit route not found" });
      let signer: string | undefined;
      try {
        signer = recoverDepositSigner(ctx.domain, route.intent, userSignature);
      } catch {}
      if (signer !== route.intent.account)
        return reply.code(401).send({ error: "invalid deposit signature" });
      if (route.transaction) return { status: "deposited", routeId, transaction: route.transaction };
      const chain = ctx.chain;
      if (!this.dev.enabled || !chain || !ctx.sender)
        return reply.code(503).send({ error: "live route adapter is not configured" });
      if (route.destinationTxHash) {
        const existing = await chain.provider.getTransactionReceipt(route.destinationTxHash);
        if (!existing)
          return reply
            .code(202)
            .send({ status: "submitted", routeId, transaction: { hash: route.destinationTxHash } });
        if (existing.status === 1) {
          const collateral = await chain.clearing.collateralOf(route.intent.account);
          route.transaction = {
            hash: route.destinationTxHash,
            blockNumber: existing.blockNumber,
            collateral: collateral.toString(),
          };
          this.setStatus(routeId, route, "deposited");
          return this.deposited(routeId, route);
        }
      }
      if (Number(route.intent.deadline) * 1_000 <= Date.now())
        return reply.code(409).send({ error: "deposit route expired" });
      this.setStatus(routeId, route, "authorized");
      try {
        const receipt = await this.dev.mintAndDeposit(
          "deposit",
          route.intent.routeId,
          route.intent.account,
          route.expectedUsdc,
          route.intent.routeId,
        );
        route.destinationTxHash = receipt.hash;
        ctx.journal
          ?.prepare("UPDATE deposit_routes SET destination_tx=?, updated_ms=? WHERE route_id=?")
          .run(receipt.hash, Date.now(), routeId);
        const collateral = await chain.clearing.collateralOf(route.intent.account);
        route.transaction = {
          hash: receipt.hash,
          blockNumber: receipt.blockNumber,
          collateral: collateral.toString(),
        };
        this.setStatus(routeId, route, "deposited");
        return this.deposited(routeId, route);
      } catch (error) {
        return reply.code(409).send({ error: publicError(error, "deposit failed") });
      }
    });
  }
}
