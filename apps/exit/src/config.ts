// Build-time configuration. The exit page has no API: everything it needs is baked in here and
// checked against the chain when a wallet connects.
import { getAddress, isAddress } from "ethers";

export interface ChainInfo {
  name: string;
  explorer?: string;
  /** Parameters for wallet_addEthereumChain when the wallet does not know the chain yet. */
  add?: { chainName: string; rpcUrls: string[]; nativeCurrency: { name: string; symbol: string; decimals: number }; blockExplorerUrls: string[] };
}

const ETHER = { name: "Ether", symbol: "ETH", decimals: 18 };
export const CHAINS: Record<string, ChainInfo> = {
  "8453": { name: "Base", explorer: "https://basescan.org", add: { chainName: "Base", rpcUrls: ["https://mainnet.base.org"], nativeCurrency: ETHER, blockExplorerUrls: ["https://basescan.org"] } },
  "84532": { name: "Base Sepolia", explorer: "https://sepolia.basescan.org", add: { chainName: "Base Sepolia", rpcUrls: ["https://sepolia.base.org"], nativeCurrency: ETHER, blockExplorerUrls: ["https://sepolia.basescan.org"] } },
  "31337": { name: "Local chain" },
};

/** The dev oracle nodes; a build for another deployment passes VITE_EXIT_ORACLE_NODES. */
export const DEV_ORACLE_NODES = [
  "https://oracle-1.rfq-markets.workers.dev",
  "https://oracle-2.rfq-markets.workers.dev",
  "https://oracle-3.rfq-markets.workers.dev",
];

export interface ExitConfig {
  chainId: bigint;
  chain: ChainInfo;
  clearing: string;
  oracleNodes: string[];
  /** First block worth scanning for one-click trading keys; 0 when unknown. */
  deploymentBlock: number;
  appUrl: string;
  docsUrl: string;
}

type Env = Record<string, string | undefined>;

/** Parses the build environment; returns an error message instead when the build cannot be used. */
export function readConfig(env: Env): ExitConfig | string {
  const chainText = env.VITE_EXIT_CHAIN_ID?.trim() ?? "";
  const clearing = env.VITE_EXIT_CLEARING_ADDRESS?.trim() ?? "";
  if (!/^[1-9]\d*$/.test(chainText) || !isAddress(clearing)) return "This copy of the exit page was built without a contract address, so it cannot do anything. Use the official exit page linked from the docs.";
  const nodes = (env.VITE_EXIT_ORACLE_NODES ?? (chainText === "8453" ? DEV_ORACLE_NODES.join(",") : ""))
    .split(",").map(node => node.trim().replace(/\/$/, "")).filter(node => /^https?:\/\//.test(node));
  const block = Number(env.VITE_EXIT_DEPLOYMENT_BLOCK ?? 0);
  return {
    chainId: BigInt(chainText),
    chain: CHAINS[chainText] ?? { name: `Chain ${chainText}` },
    clearing: getAddress(clearing),
    oracleNodes: nodes,
    deploymentBlock: Number.isSafeInteger(block) && block > 0 ? block : 0,
    appUrl: env.VITE_EXIT_APP_URL ?? "https://dev.rfq-markets.workers.dev",
    docsUrl: env.VITE_EXIT_DOCS_URL ?? "https://docs.rfq-markets.workers.dev/protocol/safety-and-exits",
  };
}

export const explorerTx = (config: ExitConfig, hash: string) => config.chain.explorer ? `${config.chain.explorer}/tx/${hash}` : undefined;
export const explorerAddress = (config: ExitConfig, address: string) => config.chain.explorer ? `${config.chain.explorer}/address/${address}` : undefined;
