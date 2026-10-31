import cors from "@fastify/cors";
import Fastify from "fastify";
import {
  marketRefreshIntervalMs,
  watchMarketRegistry,
  type MarketRegistryWatch,
} from "../../../packages/shared/src/markets-chain.js";
import { registerAccountRoutes } from "./account.js";
import { ChainReader } from "./chain.js";
import { ApiContext, DEFAULT_CORS_ORIGIN, type ApiOptions } from "./context.js";
import { registerSponsoredDeposits } from "./deposits.js";
import { DevChain, registerDevRoutes } from "./dev-chain.js";
import { ExecutionService } from "./execution.js";
import { registerHttpGuards } from "./http.js";
import { pruneApiJournal } from "./journal.js";
import { MarketStream } from "./market-stream.js";
import { RuntimeMetrics } from "./metrics.js";
import { registerOperationsRoutes } from "./operations.js";
import { registerLadderRoutes } from "./ladder.js";
import { LimitOrders } from "./orders.js";
import { QuoteEngine } from "./quoting.js";
import { registerSignedActions } from "./signed-actions.js";
import { registerErrorCodes, registerErrorHandler } from "../../lib/src/error-codes.js";
import { registerOpenApi } from "./openapi.js";

export type { ApiOptions } from "./context.js";

const SENDER_RECONCILE_MS = 5_000;
/** How often finished journal records past the retention window are deleted. */
const PRUNE_INTERVAL_MS = 3_600_000;

/** Build the execution leader: quoting, approval, sponsored settlement and the public read model. */
export function buildApi(options: ApiOptions = {}) {
  const app = Fastify({ logger: false, bodyLimit: 16_384, trustProxy: options.trustedProxy });
  registerErrorCodes(app);
  registerErrorHandler(app, "api");
  registerOpenApi(app);
  const ctx = new ApiContext(options),
    metrics = new RuntimeMetrics(),
    guards = registerHttpGuards(app, options, metrics);
  app.register(cors, { origin: options.corsOrigin ?? DEFAULT_CORS_ORIGIN });

  const chain = new ChainReader(ctx),
    dev = new DevChain(ctx, chain),
    quoting = new QuoteEngine(ctx, chain, dev),
    stream = new MarketStream(options, quoting),
    execution = new ExecutionService(ctx, chain, dev, quoting, stream),
    orders = new LimitOrders(ctx, chain, quoting, execution);

  registerOperationsRoutes(app, ctx, { chain, quoting, stream, orders, metrics });
  registerDevRoutes(app, ctx, dev);
  quoting.register(app, guards);
  registerLadderRoutes(app, guards, quoting);
  stream.register(app);
  registerAccountRoutes(app, ctx, quoting);
  registerSignedActions(app, ctx, chain, dev, quoting);
  registerSponsoredDeposits(app, ctx);
  orders.register(app, guards);
  execution.register(app);

  let senderReconciliation: Promise<void> | undefined,
    senderReconcileTimer: ReturnType<typeof setInterval> | undefined,
    pruneTimer: ReturnType<typeof setInterval> | undefined,
    unsubscribeOracle: (() => void) | undefined,
    registryWatch: MarketRegistryWatch | undefined;

  app.addHook("onReady", async () => {
    if (ctx.clearing) {
      // Markets governance adds appear within `marketRefreshMs` (or at once when a request names
      // one). A failed load keeps the last list; risk reads pin `marketCount` to their block and
      // fail closed while the registry lags.
      registryWatch = await watchMarketRegistry(ctx.clearing, {
        intervalMs: options.marketRefreshMs ?? marketRefreshIntervalMs(),
        requireInitial: false,
        onChange: () => {
          quoting.invalidateMarkets();
          chain.invalidateQuoteSnapshot();
          stream.schedulePublish();
        },
        onError: (error) => console.error("api market registry refresh failed", error),
      });
    }
    if (ctx.recoveredCommitments.length) {
      const versions = await chain.readProtocolVersions();
      for (const { quote } of ctx.recoveredCommitments) ctx.quotes.versions.set(quote.quoteId, versions);
    }
    const sender = ctx.sender;
    // A failed first pass must not stop the API from starting: the timer below retries every few seconds.
    await sender?.reconcile().catch((error: unknown) => console.error("sender reconciliation failed", error));
    senderReconcileTimer = setInterval(() => {
      if (sender && !senderReconciliation)
        // Nothing in flight means nothing to read: the nonce read alone would hit the RPC every tick.
        senderReconciliation = sender
          .reconcile({ idle: "skip" })
          .catch(() => {})
          .finally(() => {
            senderReconciliation = undefined;
          });
    }, SENDER_RECONCILE_MS);
    senderReconcileTimer.unref();
    const prune = () => {
      try {
        if (ctx.journal) pruneApiJournal(ctx.journal);
      } catch (error) {
        console.error("api journal pruning failed", error);
      }
      void sender?.prune?.().catch((error: unknown) => console.error("sender journal pruning failed", error));
    };
    prune();
    pruneTimer = setInterval(prune, PRUNE_INTERVAL_MS);
    pruneTimer.unref();
    unsubscribeOracle = options.oracleSource?.subscribe?.(() => {
      stream.schedulePublish();
      orders.scheduleCheck();
    });
    await options.oracleSource?.start?.();
    orders.start();
    stream.start();
  });

  app.addHook("onClose", async () => {
    registryWatch?.stop();
    if (senderReconcileTimer) clearInterval(senderReconcileTimer);
    if (pruneTimer) clearInterval(pruneTimer);
    orders.close();
    stream.close();
    unsubscribeOracle?.();
    await options.oracleSource?.close?.();
    await senderReconciliation;
    ctx.provider?.destroy();
    ctx.journal?.close();
  });
  return app;
}
