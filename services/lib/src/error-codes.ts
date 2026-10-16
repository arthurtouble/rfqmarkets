import { STATUS_CODES } from "node:http";
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

/** Replaces every URL's path and query with "…", so RPC endpoints keyed in their path never reach logs. */
export function redactUrls(text: string) {
  return text.replace(/\b(https?|wss?):\/\/([^/\s"'`]+)[^\s"'`]*/g, "$1://$2/…");
}

/**
 * Replaces Fastify's default error handler, which echoes `error.message` to the client. Server errors
 * (an ethers SERVER_ERROR carries the RPC request URL, API key included) are logged here with URLs
 * redacted and answered with a generic `{ error: "internal error", code, retryable }`. Client errors
 * (validation, malformed JSON, oversized bodies) keep their message, which describes the request itself.
 */
export function registerErrorHandler(
  app: FastifyInstance,
  service: string,
  log: (message: string) => void = (message) => console.error(message),
) {
  app.setErrorHandler((error: unknown, request, reply) => {
    const raw = (error as { statusCode?: unknown } | null)?.statusCode,
      status = typeof raw === "number" && raw >= 400 && raw < 600 ? raw : 500;
    if (status < 500) {
      const message = error instanceof Error ? error.message : "invalid request",
        code = apiErrorCode(status, message);
      return reply.code(status).send({
        statusCode: status,
        error: STATUS_CODES[status] ?? "Error",
        message,
        code,
        retryable: apiErrorRetryable(code),
      });
    }
    const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
    log(redactUrls(`${service} ${request.method} ${request.routeOptions.url ?? "?"} failed: ${detail}`));
    const code = apiErrorCode(status, "");
    return reply.code(status).send({ error: "internal error", code, retryable: apiErrorRetryable(code) });
  });
}
