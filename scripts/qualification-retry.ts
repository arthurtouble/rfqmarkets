export class QualificationResponseError extends Error {
  constructor(
    readonly path: string,
    readonly status: number,
    readonly body: { error?: string; details?: string[] },
  ) {
    super(`${path}: ${JSON.stringify(body)}`);
  }
}

// These approval rejections occur before chain submission. Never
// retry an ambiguous submission, timeout, or generic policy rejection here.
export function btcRetryDelay(error: unknown): number | null {
  if (!(error instanceof QualificationResponseError) || error.path !== "/v1/approve") return null;
  if (error.status === 409 && error.body.error === "price moved beyond signed protection") return 250;
  if (error.status === 503 && error.body.error === "fresh settlement price unavailable") return 5_000;
  // A timed-out quorum may have reserved capacity, but the API did not submit.
  // Allow the 30-second signed approvals to expire before requesting a new intent.
  if (
    error.status === 503 &&
    error.body.error === "approver quorum unavailable" &&
    Array.isArray(error.body.details) &&
    error.body.details.length > 0 &&
    error.body.details.every((detail) => typeof detail === "string" && detail.startsWith("TimeoutError:"))
  )
    return 40_000;
  return null;
}

export function transientReadError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const value = error as { code?: string; cause?: unknown; error?: unknown };
  return (
    ["ENOTFOUND", "EAI_AGAIN", "ECONNRESET", "ETIMEDOUT", "TIMEOUT", "NETWORK_ERROR"].includes(
      value.code ?? "",
    ) ||
    transientReadError(value.cause) ||
    transientReadError(value.error)
  );
}

export async function retryQualification<T>(
  run: () => Promise<T>,
  delay: (error: unknown) => number | null,
  options: { attempts?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<T> {
  const attempts = options.attempts ?? 12,
    sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  for (let attempt = 1; ; attempt++)
    try {
      return await run();
    } catch (error) {
      const ms = delay(error);
      if (ms === null || attempt >= attempts) throw error;
      await sleep(ms);
    }
}

// Only for a fresh qualification API with an empty sender journal, before any
// intents are submitted. Fastify caches a failed ready() promise, so retries
// must close the failed instance and build another one, not call ready() again.
export async function startQualificationApp<
  T extends { ready(): PromiseLike<unknown>; close(): Promise<unknown> },
>(build: () => T, options: { attempts?: number; sleep?: (ms: number) => Promise<void> } = {}): Promise<T> {
  return retryQualification(
    async () => {
      const app = build();
      try {
        await app.ready();
        return app;
      } catch (error) {
        await app.close();
        throw error;
      }
    },
    (error) => (transientReadError(error) ? 5_000 : null),
    options,
  );
}
