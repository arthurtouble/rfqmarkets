import type { FastifyInstance } from "fastify";
import { apiErrorCode, apiErrorRetryable } from "../../../packages/shared/src/api-errors.js";

/**
 * Adds the stable `code` and `retryable` fields (packages/shared/src/api-errors.ts) to every JSON error
 * response, including Fastify's own (`{ statusCode, error, message }`). Fields a route set itself win.
 */
export function registerErrorCodes(app: FastifyInstance) {
  app.addHook("preSerialization", async (_request, reply, payload) => {
    if (reply.statusCode < 400 || !payload || typeof payload !== "object" || Array.isArray(payload))
      return payload;
    const body = payload as Record<string, unknown>;
    if (typeof body.code === "string" && typeof body.retryable === "boolean") return payload;
    const message = typeof body.error === "string" ? body.error : "";
    const code = typeof body.code === "string" ? body.code : apiErrorCode(reply.statusCode, message);
    return {
      ...body,
      code,
      // Routes that already flag `retriable` (the older spelling) know best.
      retryable:
        typeof body.retryable === "boolean"
          ? body.retryable
          : typeof body.retriable === "boolean"
            ? body.retriable
            : apiErrorRetryable(code as never),
    };
  });
}
