import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { clientIdentity } from "../../../packages/shared/src/client-identity.js";
import { QuoteAdmission } from "./admission.js";
import type { ApiOptions } from "./context.js";
import type { RuntimeMetrics } from "./metrics.js";

/** A route outcome that a handler sends verbatim; lets services stay independent of Fastify. */
export class Reply {
  constructor(
    readonly status: number,
    readonly body: unknown,
  ) {}
  static error(status: number, error: string, extra: Record<string, unknown> = {}) {
    return new Reply(status, { error, ...extra });
  }
  send(reply: FastifyReply) {
    return reply.code(this.status).send(this.body);
  }
}

/** Fixed latency labels; the metric set cannot grow with paths, accounts or quote IDs. */
const METRIC_LABELS: Record<string, string> = {
  "/v1/quote": "firmQuote",
  "/v1/prepare": "intentPrepare",
  "/v1/approve": "tradeApproval",
  "/v1/close/quote": "closeQuote",
  "/v1/account/:address": "accountRead",
  "/v1/markets": "marketRead",
};

export interface HttpGuards {
  /** Spend a firm-quote token for quote-shaped work; replies 429 and returns false when exhausted. */
  admitQuoteWork(request: FastifyRequest, reply: FastifyReply): boolean;
}

/** Per-client origin budgets for every public route, plus latency metrics for the hot paths. */
export function registerHttpGuards(
  app: FastifyInstance,
  options: ApiOptions,
  metrics: RuntimeMetrics,
): HttpGuards {
  const quoteAdmission = new QuoteAdmission(
    options.firmQuoteRatePerSecond,
    options.firmQuoteBurst,
    options.maxQuoteAdmissionClients,
    options.globalFirmQuoteRatePerSecond,
    options.globalFirmQuoteBurst,
  );
  const publicReads = new QuoteAdmission(100, options.publicReadBurst ?? 200, 10_000, 2000, 4000);
  const publicWrites = new QuoteAdmission(20, options.publicWriteBurst ?? 200, 10_000, 200, 2000);
  const requestStarts = new WeakMap<object, number>(),
    client = clientIdentity(options);

  app.addHook("onRequest", async (request, reply) => {
    requestStarts.set(request, performance.now());
    if (request.url.split("?", 1)[0].startsWith("/v1/") && request.method !== "OPTIONS") {
      const admission = request.method === "GET" ? publicReads : publicWrites;
      if (!admission.allow(client(request)))
        return reply.code(429).header("retry-after", "1").send({ error: "request rate limit exceeded" });
    }
  });
  app.addHook("onResponse", async (request, reply) => {
    const route = request.routeOptions.url,
      label = route ? METRIC_LABELS[route] : undefined,
      started = requestStarts.get(request);
    if (label && started !== undefined) metrics.record(label, performance.now() - started, reply.statusCode);
  });

  return {
    admitQuoteWork(request, reply) {
      if (quoteAdmission.allow(client(request))) return true;
      reply.header("retry-after", "1");
      reply.code(429).send({ error: "quote rate limit exceeded" });
      return false;
    },
  };
}
