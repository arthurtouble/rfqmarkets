import cors from "@fastify/cors";
import Fastify from "fastify";
import {
  marketRefreshIntervalMs,
  watchMarketRegistry,
  type MarketRegistryWatch,
} from "../../../packages/shared/src/markets.js";
import { registerAccountRoutes } from "./account.js";
import { ChainReader } from "./chain.js";
import { ApiContext, DEFAULT_CORS_ORIGIN, type ApiOptions } from "./context.js";
import { DevChain, registerDevRoutes } from "./dev-chain.js";
import { ExecutionService } from "./execution.js";
import { registerHttpGuards } from "./http.js";
import { MarketStream } from "./market-stream.js";
import { RuntimeMetrics } from "./metrics.js";
import { registerOperationsRoutes } from "./operations.js";
import { LimitOrders } from "./orders.js";
import { QuoteEngine } from "./quoting.js";
import { registerSignedActions } from "./signed-actions.js";

export type { ApiOptions } from "./context.js";

const SENDER_RECONCILE_MS = 5_000;

/** Build the execution leader: quoting, approval, sponsored settlement and the public read model. */
export function buildApi(options: ApiOptions = {}) {
  const app = Fastify({ logger: false, bodyLimit: 16_384, trustProxy: options.trustedProxy });
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
  stream.register(app);
  registerAccountRoutes(app, ctx, quoting);
  registerSignedActions(app, ctx, chain, dev, quoting);
  orders.register(app, guards);
  execution.register(app);

  let senderReconciliation: Promise<void> | undefined,
    senderReconcileTimer: ReturnType<typeof setInterval> | undefined,
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
    await sender?.reconcile();
    senderReconcileTimer = setInterval(() => {
      if (sender && !senderReconciliation)
        senderReconciliation = sender
          .reconcile()
          .catch(() => {})
          .finally(() => {
            senderReconciliation = undefined;
          });
    }, SENDER_RECONCILE_MS);
    senderReconcileTimer.unref();
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
