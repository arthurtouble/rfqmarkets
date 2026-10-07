// Which settlement chain and contracts the app trusts. GET /v1/config names
// them, so one build serves the local stack, Base Sepolia and Base, but the API
// is not trusted to choose the contracts a wallet approves, deposits into or
// signs for. A deployed build pins them at build time (VITE_CHAIN_ID,
// VITE_CLEARING_ADDRESS, VITE_TOKEN_ADDRESS, as the exit page does); a config
// that disagrees is refused and the app stays read-only. Known chains always
// use their public RPC, never one the API names. Local dev builds set no pins.
//
// Pure (no import.meta.env), so settlement.test.ts runs it under Node.
import { base, baseSepolia } from "viem/chains";
import { defineChain, getAddress, isAddress, type Address, type Chain } from "viem";
import type { ChainConfig } from "../lib/types.js";

/** `error` is set when the config was refused; `config` is then null and nothing can be signed or sent. */
export type Settlement = { chain: Chain; config: ChainConfig | null; error?: string };

export const KNOWN_CHAINS: Record<number, Chain> = { [base.id]: base, [baseSepolia.id]: baseSepolia };

/** Contracts this build trusts. Every field is optional; unset means "take the API's". */
export type Pins = { chainId?: number; clearing?: Address; token?: Address };
export type BuildEnv = Record<string, string | boolean | undefined>;

/** Reads the build-time pins; a malformed value throws so a misconfigured build fails closed. */
export function readPins(env: BuildEnv): Pins {
  const text = (key: string) => (typeof env[key] === "string" ? (env[key] as string).trim() : "");
  const pins: Pins = {};
  const chainId = text("VITE_CHAIN_ID"), clearing = text("VITE_CLEARING_ADDRESS"), token = text("VITE_TOKEN_ADDRESS");
  if (chainId) {
    if (!/^[1-9]\d{0,15}$/.test(chainId)) throw new Error("This build has an invalid VITE_CHAIN_ID, so trading is disabled.");
    pins.chainId = Number(chainId);
  }
  if (clearing) {
    if (!isAddress(clearing, { strict: false })) throw new Error("This build has an invalid VITE_CLEARING_ADDRESS, so trading is disabled.");
    pins.clearing = getAddress(clearing);
  }
  if (token) {
    if (!isAddress(token, { strict: false })) throw new Error("This build has an invalid VITE_TOKEN_ADDRESS, so trading is disabled.");
    pins.token = getAddress(token);
  }
  return pins;
}

/** What in `config` disagrees with `pins` (or is malformed), or null when it can be used. */
export function pinMismatch(config: ChainConfig, pins: Pins): string | null {
  let chainId: bigint;
  try { chainId = BigInt(config.chainId); } catch { return "an invalid chain"; }
  if (chainId <= 0n || chainId > BigInt(Number.MAX_SAFE_INTEGER)) return "an invalid chain";
  if (pins.chainId !== undefined && chainId !== BigInt(pins.chainId)) return "a different chain";
  if (typeof config.clearingAddress !== "string" || !isAddress(config.clearingAddress, { strict: false })) return "an invalid settlement contract";
  if (pins.clearing && getAddress(config.clearingAddress) !== pins.clearing) return "a different settlement contract";
  if (config.tokenAddress !== undefined && (typeof config.tokenAddress !== "string" || !isAddress(config.tokenAddress, { strict: false }))) return "an invalid USDC token";
  if (pins.token && (!config.tokenAddress || getAddress(config.tokenAddress) !== pins.token)) return "a different USDC token";
  return null;
}

export function chainFor(config: ChainConfig): Chain {
  const id = Number(BigInt(config.chainId));
  // A known chain keeps its public RPC: an RPC chosen by the API could misreport allowances, balances and receipts.
  const known = KNOWN_CHAINS[id];
  if (known) return known;
  const rpc = config.rpcUrl ? [config.rpcUrl] : [];
  return defineChain({ id, name: config.chainName, nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: rpc } } });
}

/** The chain to show while the config is unavailable or refused. */
const fallbackChain = (pins: Pins) => (pins.chainId !== undefined ? KNOWN_CHAINS[pins.chainId] : undefined) ?? base;

/** Resolves the settlement from the build environment and a loader for GET /v1/config. Never throws. */
export async function resolveSettlement(env: BuildEnv, fetchConfig: () => Promise<ChainConfig>): Promise<Settlement> {
  let pins: Pins;
  try { pins = readPins(env); } catch (error) {
    return { chain: base, config: null, error: (error as Error).message };
  }
  let config: ChainConfig;
  try { config = await fetchConfig(); } catch {
    return { chain: fallbackChain(pins), config: null };
  }
  const mismatch = pinMismatch(config, pins);
  if (mismatch) return {
    chain: fallbackChain(pins), config: null,
    error: `Trading is disabled: the server's configuration names ${mismatch}, which this app does not trust. Do not sign anything from this page. To withdraw, use the exit page linked from the docs.`,
  };
  // Pinned addresses win over the server's spelling of them.
  return { chain: chainFor(config), config: { ...config, clearingAddress: pins.clearing ?? config.clearingAddress, tokenAddress: pins.token ?? config.tokenAddress } };
}
