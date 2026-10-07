// The settlement chain and contracts: GET /v1/config, checked against the
// build-time pins in settlement.ts. Without an API we assume Base (or the
// pinned chain).
import { createConfig, http, type CreateConnectorFn } from "wagmi";
import { baseAccount, injected, walletConnect } from "wagmi/connectors";
import type { Chain } from "viem";
import { API, WALLETCONNECT_PROJECT_ID } from "../lib/env.js";
import { getJson } from "../lib/http.js";
import type { ChainConfig } from "../lib/types.js";
import { KNOWN_CHAINS, resolveSettlement, type Settlement } from "./settlement.js";

export { chainFor, type Settlement } from "./settlement.js";

export const loadSettlement = (): Promise<Settlement> =>
  resolveSettlement(import.meta.env, () => getJson<ChainConfig>(`${API}/v1/config`, AbortSignal.timeout(3_000)));

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
  if (chain.id in KNOWN_CHAINS) connectors.push(lazyConnector(baseAccount({ appName: APP.name, preference: { telemetry: false } })));
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
