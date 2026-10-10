import {
  BaseContract,
  FetchRequest,
  Interface,
  JsonRpcProvider,
  type BlockTag,
  type JsonRpcApiProviderOptions,
  type JsonRpcError,
  type JsonRpcPayload,
  type JsonRpcResult,
  type Networkish,
  type Provider,
} from "ethers";

/** Multicall3, deployed at this address on Base and most EVM chains (not on a plain Hardhat node). */
export const MULTICALL3_ADDRESS = "0xcA11bde05977b3631167028862bE2a173976CA11";
const multicall3 = new Interface([
  "function aggregate3((address target,bool allowFailure,bytes callData)[] calls) payable returns ((bool success,bytes returnData)[] returnData)",
]);
/** Calls per aggregate3; view reads of a few storage slots each stay far below RPC gas caps. */
const MAX_AGGREGATE_CALLS = 200;
const multicallDeployed = new WeakMap<Provider, Promise<boolean>>();

function hasMulticall(provider: Provider) {
  let deployed = multicallDeployed.get(provider);
  if (!deployed) {
    deployed = provider.getCode(MULTICALL3_ADDRESS).then((code) => code !== "0x");
    // A failed lookup is retried on the next read rather than cached.
    deployed.catch(() => multicallDeployed.delete(provider));
    multicallDeployed.set(provider, deployed);
  }
  return deployed;
}

export type ViewCall = readonly [method: string, ...args: unknown[]];

/**
 * Read several views of one contract at one block. Through Multicall3 when the chain has it, so N reads
 * cost one eth_call (metered RPCs such as Alchemy bill per call); otherwise one call each. Results match
 * what `contract[method].staticCall` returns, and any revert fails the whole read.
 */
export async function readViews(
  contract: BaseContract,
  calls: readonly ViewCall[],
  blockTag?: BlockTag,
): Promise<unknown[]> {
  const provider = contract.runner?.provider,
    overrides = blockTag === undefined ? {} : { blockTag };
  if (!calls.length) return [];
  if (!provider || calls.length === 1 || !(await hasMulticall(provider)))
    return Promise.all(
      calls.map(([method, ...args]) => contract.getFunction(method).staticCall(...args, overrides)),
    );
  const target = await contract.getAddress(),
    chunks: Array<readonly ViewCall[]> = [];
  for (let start = 0; start < calls.length; start += MAX_AGGREGATE_CALLS)
    chunks.push(calls.slice(start, start + MAX_AGGREGATE_CALLS));
  const results = await Promise.all(
    chunks.map(async (chunk) => {
      const data = multicall3.encodeFunctionData("aggregate3", [
        chunk.map(([method, ...args]) => ({
          target,
          allowFailure: false,
          callData: contract.interface.encodeFunctionData(method, args),
        })),
      ]);
      const [returns] = multicall3.decodeFunctionResult(
        "aggregate3",
        await provider.call({ to: MULTICALL3_ADDRESS, data, ...overrides }),
      );
      return chunk.map(([method], index) => {
        const result = contract.interface.decodeFunctionResult(method, returns[index].returnData);
        return contract.interface.getFunction(method)!.outputs.length === 1 ? result[0] : result;
      });
    }),
  );
  return results.flat();
}

/** True for a contract revert, which every RPC would answer the same; anything else is worth a retry. */
const isRevert = (error: JsonRpcError["error"]) =>
  error.code === 3 ||
  /revert/i.test(error.message ?? "") ||
  (typeof error.data === "string" && error.data !== "0x");

/**
 * Sends each request to the first RPC and, when it fails, times out or answers with a non-revert RPC
 * error (rate limits, outages), resends it to the next. Lets a polling read path run on a free RPC while
 * a metered one (Alchemy) only takes what the free one drops. Retries are immediate: ethers' own
 * back-off on 429 is turned off for every RPC but the last.
 */
export class FallbackRpcProvider extends JsonRpcProvider {
  readonly #fallbacks: JsonRpcProvider[];

  constructor(
    urls: readonly string[],
    network?: Networkish,
    options: JsonRpcApiProviderOptions & { timeoutMs?: number } = {},
  ) {
    const { timeoutMs = 1_500, ...providerOptions } = options;
    if (!urls.length) throw new Error("FallbackRpcProvider needs at least one RPC URL");
    const request = (url: string, last: boolean) => {
      const fetch = new FetchRequest(url);
      if (!last) {
        fetch.timeout = timeoutMs;
        fetch.setThrottleParams({ maxAttempts: 1 });
      }
      return fetch;
    };
    super(request(urls[0], urls.length === 1), network, providerOptions);
    this.#fallbacks = urls
      .slice(1)
      .map(
        (url, index) =>
          new JsonRpcProvider(request(url, index === urls.length - 2), network, providerOptions),
      );
  }

  // ethers types the results as JsonRpcResult, but error responses come back in the same array.
  override async _send(payload: JsonRpcPayload | JsonRpcPayload[]): Promise<JsonRpcResult[]> {
    const senders = [
      (body: typeof payload) => super._send(body),
      ...this.#fallbacks.map((provider) => provider._send.bind(provider)),
    ];
    for (const [index, send] of senders.entries()) {
      const last = index === senders.length - 1;
      try {
        const results = await send(payload),
          failed = (results as Array<JsonRpcResult | JsonRpcError>).some(
            (result) => "error" in result && !isRevert(result.error),
          );
        if (last || !failed) return results;
      } catch (error) {
        if (last) throw error;
      }
    }
    throw new Error("unreachable");
  }

  override destroy() {
    for (const provider of this.#fallbacks) provider.destroy();
    super.destroy();
  }
}
