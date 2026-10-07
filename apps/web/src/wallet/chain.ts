// The settlement chain comes from GET /v1/config, so one build serves the
// local stack, Base Sepolia and Base. Without an API we assume Base.
import { createConfig, http } from "wagmi";
import { injected } from "wagmi/connectors";
import { base, baseSepolia } from "wagmi/chains";
import { defineChain, type Chain } from "viem";
import { API } from "../lib/env.js";
import { getJson } from "../lib/http.js";
import type { ChainConfig } from "../lib/types.js";

export type Settlement = { chain: Chain; config: ChainConfig | null };

const KNOWN: Record<number, Chain> = { [base.id]: base, [baseSepolia.id]: baseSepolia };

export function chainFor(config: ChainConfig): Chain {
  const id = Number(BigInt(config.chainId));
  const known = KNOWN[id];
  const rpc = config.rpcUrl ? [config.rpcUrl] : known?.rpcUrls.default.http ?? [];
  if (known) return { ...known, rpcUrls: { default: { http: rpc } } };
  return defineChain({ id, name: config.chainName, nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: rpc } } });
}

export async function loadSettlement(): Promise<Settlement> {
  try {
    const config = await getJson<ChainConfig>(`${API}/v1/config`, AbortSignal.timeout(3_000));
    return { chain: chainFor(config), config };
  } catch {
    return { chain: base, config: null };
  }
}

export function createWagmiConfig(chain: Chain) {
  return createConfig({
    chains: [chain],
    connectors: [injected()],
    transports: { [chain.id]: http() },
  });
}
