import Fastify, { type FastifyRequest } from "fastify";
import { JsonRpcProvider, Wallet } from "ethers";
import { approverPayloadSchema } from "../../../packages/shared/src/approver-payload.js";
import {
  marketRefreshIntervalMs,
  watchMarketRegistry,
  type MarketRegistryWatch,
} from "../../../packages/shared/src/markets.js";
import { bearerMatches } from "../../lib/src/auth.js";
import { approve, type ApproverContext } from "./approve.js";
import { createChainClients } from "./chain-state.js";
import { ApprovalJournal } from "./journal.js";
import type { ApproverOptions } from "./options.js";

export type { ApproverOptions } from "./options.js";
export const requestSchema = approverPayloadSchema;

/**
 * Independent maker approver: re-validates a leader's fully specified envelope
 * against its own RPC, hedger risk state, exposure model and gross-reservation
 * journal before co-signing the `MakerApproval` digest.
 */
export function buildApprover(options: ApproverOptions) {
  // Entrypoints additionally require a strong token (requireStrongToken); an empty one is never valid.
  if (!options.transportToken) throw new Error("approver transport token is required");
  const wallet = new Wallet(options.privateKey);
  // Some independent RPC providers reject JSON-RPC batches. Explicit single
  // requests keep an approver compatible with those providers and preserve quorum.
  const provider =
    options.provider ??
    (options.rpcUrl
      ? new JsonRpcProvider(options.rpcUrl, undefined, { batchMaxCount: options.rpcBatchMaxCount ?? 1 })
      : undefined);
  const secondaryProvider = options.secondaryRpcUrl
    ? new JsonRpcProvider(options.secondaryRpcUrl, undefined, { batchMaxCount: 1 })
    : undefined;
  if (provider && (!options.expectedChainId || !options.expectedVerifyingContract))
    throw new Error("Independent chain signing requires a pinned chain and clearing address");
  const chain =
    provider && options.expectedVerifyingContract
      ? createChainClients(provider, secondaryProvider, options.expectedVerifyingContract)
      : undefined;
  const journal = new ApprovalJournal(
    options.databasePath,
    `${options.expectedChainId ?? "development"}:${options.expectedVerifyingContract?.toLowerCase() ?? "development"}:${wallet.address.toLowerCase()}`,
  );
  const context: ApproverContext = {
    options,
    signer: wallet.address,
    sign: (digest) => wallet.signingKey.sign(digest).serialized,
    journal,
    chain,
  };
  const authorized = (request: FastifyRequest) =>
    bearerMatches(request.headers.authorization, options.transportToken);

  const app = Fastify({ logger: false, bodyLimit: 16_384 });
  app.get("/health", async () => ({ ok: !journal.incompleteLegacy, signer: wallet.address }));
  app.get("/internal/recovery", async (request, reply) => {
    if (!authorized(request)) return reply.code(401).send({ error: "unauthorized" });
    return journal.recoveryExport(wallet.address);
  });
  app.post("/approve", async (request, reply) => {
    if (!authorized(request)) return reply.code(401).send({ error: "unauthorized" });
    const parsed = requestSchema.safeParse(request.body);
    if (!parsed.success)
      return reply.code(400).send({
        error: "invalid request",
        details:
          process.env.NODE_ENV === "test"
            ? parsed.error.issues.map((issue) => issue.path.join("."))
            : undefined,
      });
    const result = await approve(context, parsed.data);
    if ("status" in result) return reply.code(result.status).send(result.body);
    return result;
  });
  // The first approval after boot otherwise pays for provider network detection, ABI coder setup and
  // cold RPC connections, which can exceed the leader's approver timeout. Warm those paths before
  // listening. Failures are ignored: every request still performs and checks its own reads.
  let registryWatch: MarketRegistryWatch | undefined;
  app.addHook("onReady", async () => {
    if (!chain) return;
    // Markets come from this approver's own RPC; a load failure keeps the last list and the
    // per-request `marketCount` check fails closed until a refresh succeeds.
    registryWatch = await watchMarketRegistry(chain.clearing, {
      intervalMs: options.marketRefreshMs ?? marketRefreshIntervalMs(),
      requireInitial: false,
      onError: (error) => console.error("approver market registry refresh failed", error),
    });
    const latest = { blockTag: "latest" };
    await Promise.allSettled([
      chain.provider.getNetwork(),
      chain.secondaryProvider?.getNetwork(),
      chain.provider.getBlock("latest"),
      chain.secondaryProvider?.getBlock("latest"),
      chain.clearing.leaderEpoch(latest),
      chain.clearing.markets(0, latest),
      chain.clearing.exposureState(0, latest),
      chain.clearing.positionOf(wallet.address, 0, latest),
      chain.clearing.makerBacking(latest),
    ]);
  });
  app.addHook("onClose", async () => {
    registryWatch?.stop();
    journal.close();
  });
  return app;
}
