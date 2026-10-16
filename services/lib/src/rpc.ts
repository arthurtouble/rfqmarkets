import { FetchRequest, JsonRpcProvider, type JsonRpcApiProviderOptions, type Networkish } from "ethers";

/**
 * Per-request timeout for service RPC calls. ethers' default is 300 s, which lets one hung RPC request stall
 * a quote, an approval, a keeper cycle or the sponsor lane for five minutes.
 */
export const RPC_TIMEOUT_MS = 8_000;

/** A JSON-RPC provider whose every request gives up after `timeoutMs` (default RPC_TIMEOUT_MS). */
export function rpcProvider(
  url: string,
  network?: Networkish,
  options: JsonRpcApiProviderOptions & { timeoutMs?: number } = {},
) {
  const { timeoutMs = RPC_TIMEOUT_MS, ...providerOptions } = options,
    request = new FetchRequest(url);
  request.timeout = timeoutMs;
  return new JsonRpcProvider(request, network, providerOptions);
}
