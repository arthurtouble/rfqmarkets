// The settlement chain comes from GET /v1/config, so one build serves the
// local stack, Base Sepolia and Base. Without an API we assume Base.
import { createConfig, http, type CreateConnectorFn } from "wagmi";
import { baseAccount, injected, walletConnect } from "wagmi/connectors";
import { base, baseSepolia } from "wagmi/chains";
import { defineChain, type Chain } from "viem";
import { API, WALLETCONNECT_PROJECT_ID } from "../lib/env.js";
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

/** Defers a heavy wallet SDK until someone picks that wallet. wagmi asks every
 * connector for its provider on page load to restore sessions; this answers
 * "not connected" without downloading the SDK unless it was the last wallet used. */
export function lazyConnector(create: CreateConnectorFn): CreateConnectorFn {
  return config => {
    const connector = create(config);
    let chosen = false;
    const loaded = async () => {
      if (chosen) return true;
      try { return (await config.storage?.getItem("recentConnectorId")) === connector.id; } catch { return false; }
    };
    return {
      ...connector,
      async setup() { if (await loaded()) await connector.setup?.call(this); },
      async getProvider(parameters) {
        if (!(await loaded())) throw new Error(`${connector.name} not loaded`);
        return connector.getProvider.call(this, parameters);
      },
      async isAuthorized() { return (await loaded()) && connector.isAuthorized.call(this); },
      async connect(parameters) { chosen = true; return connector.connect.call(this, parameters); },
    } as typeof connector;
  };
}

const APP = { name: "RFQ Markets", url: "https://dev.rfq-markets.workers.dev" };

/** Installed wallets (EIP-6963), Base Account passkeys on Base networks, and
 * WalletConnect for phone and QR wallets. */
export function walletConnectors(chain: Chain) {
  const connectors: CreateConnectorFn[] = [injected()];
  if (chain.id in KNOWN) connectors.push(lazyConnector(baseAccount({ appName: APP.name, preference: { telemetry: false } })));
  const origin = typeof location === "undefined" ? APP.url : location.origin;
  connectors.push(lazyConnector(walletConnect({
    projectId: WALLETCONNECT_PROJECT_ID,
    metadata: { name: APP.name, description: "Request-for-quote markets on Base", url: origin, icons: [] },
  })));
  return connectors;
}

export function createWagmiConfig(chain: Chain) {
  return createConfig({
    chains: [chain],
    connectors: walletConnectors(chain),
    transports: { [chain.id]: http() },
  });
}
