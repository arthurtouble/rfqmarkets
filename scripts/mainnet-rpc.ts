import { JsonRpcProvider } from "ethers";

/** True for an RPC rate-limit answer: HTTP 429, or a JSON-RPC error such as mainnet.base.org's -32007 "25/second request limit reached". */
export const isRateLimited = (error: unknown) => {
  const e = error as {
    error?: { code?: number; message?: string };
    info?: { responseStatus?: string };
    message?: string;
  };
  return (
    e?.error?.code === -32007 ||
    e?.info?.responseStatus?.startsWith("429") === true ||
    /rate limit|request limit|too many requests/i.test(`${e?.error?.message ?? ""} ${e?.message ?? ""}`)
  );
};

/**
 * A provider for scripts that broadcast on Base mainnet through a public or metered RPC. It checks the
 * chain once instead of before every call, sends one request per HTTP call, polls receipts every two
 * seconds, and backs off and retries a call the RPC refused for rate limiting.
 */
export class MainnetRpcProvider extends JsonRpcProvider {
  constructor(
    url: string,
    private readonly retry = { attempts: 6, delayMs: 1_000 },
  ) {
    super(url, undefined, { staticNetwork: true, batchMaxCount: 1, pollingInterval: 2_000 });
  }

  override async send(method: string, params: Array<unknown> | Record<string, unknown>): Promise<unknown> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await super.send(method, params);
      } catch (error) {
        if (attempt >= this.retry.attempts || !isRateLimited(error)) throw error;
        await new Promise((done) => setTimeout(done, this.retry.delayMs * 2 ** (attempt - 1)));
      }
    }
  }
}
