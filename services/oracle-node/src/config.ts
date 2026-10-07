import { getAddress } from "ethers";
import type { AggregationConfig, StableConfig } from "./aggregate.js";
import { parseMarkets, type OracleMarketDefinition } from "./markets.js";
import { EXCHANGES, type ExchangeName } from "./symbols.js";

export interface OracleNodeConfig {
  /** Kept only long enough to build the signer; never logged. */
  signerKey: string;
  chainId: bigint;
  verifyingContract: string;
  markets: OracleMarketDefinition[];
  /** True when ORACLE_MARKETS was set (with a chain source it is an allowlist). */
  marketsConfigured: boolean;
  /** Read the market list from the clearing registry (ORACLE_RPC_URL + ORACLE_CLEARING_ADDRESS). */
  registry?: { rpcUrl: string; clearing: string; refreshMs: number };
  exchanges: ExchangeName[];
  tickMs: number;
  aggregation: AggregationConfig;
  stable: StableConfig;
  candleRetentionMs: number;
  host: string;
  port: number;
  corsOrigins: string[];
}

/**
 * Reads the node configuration from the environment:
 *
 * ORACLE_SIGNER_KEY (required), ORACLE_CHAIN_ID (required), ORACLE_VERIFYING_CONTRACT (required),
 * ORACLE_MARKETS (`0:BTC,1:ETH` or JSON), ORACLE_RPC_URL + ORACLE_CLEARING_ADDRESS (price every
 * market the clearing registry lists; ORACLE_MARKETS then restricts it), ORACLE_MARKET_REFRESH_MS
 * (60000), ORACLE_EXCHANGES (comma list, default all),
 * ORACLE_TICK_MS (1000), ORACLE_MAX_SOURCE_AGE_MS (2000), ORACLE_MAX_DEVIATION_BPS (50),
 * ORACLE_MIN_SOURCES (3), ORACLE_MAX_WIDTH_BPS (100), ORACLE_STABLE_MIN_SOURCES (2),
 * ORACLE_STABLE_MAX_DEPEG_BPS (500), ORACLE_USDC_PAR_BPS (10), ORACLE_CANDLE_RETENTION_HOURS (24),
 * ORACLE_HOST (127.0.0.1), ORACLE_PORT (4900), ORACLE_CORS_ORIGINS (comma list).
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): OracleNodeConfig {
  const required = (name: string) => {
    const value = env[name]?.trim();
    if (!value) throw new Error(`missing ${name}`);
    return value;
  };
  const integer = (name: string, fallback: number, min = 0, max = Number.MAX_SAFE_INTEGER) => {
    const raw = env[name]?.trim(),
      value = raw ? Number(raw) : fallback;
    if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`invalid ${name}`);
    return value;
  };
  const signerKey = required("ORACLE_SIGNER_KEY");
  if (!/^(0x)?[0-9a-fA-F]{64}$/.test(signerKey)) throw new Error("invalid ORACLE_SIGNER_KEY");
  const chainIdText = required("ORACLE_CHAIN_ID");
  if (!/^\d+$/.test(chainIdText) || BigInt(chainIdText) === 0n) throw new Error("invalid ORACLE_CHAIN_ID");
  let verifyingContract: string;
  try {
    verifyingContract = getAddress(required("ORACLE_VERIFYING_CONTRACT"));
  } catch {
    throw new Error("invalid ORACLE_VERIFYING_CONTRACT");
  }
  const exchanges = env.ORACLE_EXCHANGES?.trim()
    ? env.ORACLE_EXCHANGES.split(",").map((name) => name.trim().toLowerCase())
    : [...EXCHANGES];
  for (const exchange of exchanges)
    if (!(EXCHANGES as readonly string[]).includes(exchange)) throw new Error(`unknown exchange ${exchange}`);
  const maxAgeMs = integer("ORACLE_MAX_SOURCE_AGE_MS", 2_000, 1);
  const rpcUrl = env.ORACLE_RPC_URL?.trim(),
    clearingText = env.ORACLE_CLEARING_ADDRESS?.trim();
  if (Boolean(rpcUrl) !== Boolean(clearingText))
    throw new Error("ORACLE_RPC_URL and ORACLE_CLEARING_ADDRESS must be set together");
  let registry: OracleNodeConfig["registry"];
  if (rpcUrl && clearingText) {
    let clearing: string;
    try {
      clearing = getAddress(clearingText);
    } catch {
      throw new Error("invalid ORACLE_CLEARING_ADDRESS");
    }
    registry = { rpcUrl, clearing, refreshMs: integer("ORACLE_MARKET_REFRESH_MS", 60_000, 1_000) };
  }
  return {
    signerKey,
    chainId: BigInt(chainIdText),
    verifyingContract,
    markets: parseMarkets(env.ORACLE_MARKETS),
    marketsConfigured: Boolean(env.ORACLE_MARKETS?.trim()),
    registry,
    exchanges: exchanges as ExchangeName[],
    tickMs: integer("ORACLE_TICK_MS", 1_000, 100),
    aggregation: {
      maxAgeMs,
      maxDeviationBps: integer("ORACLE_MAX_DEVIATION_BPS", 50, 1, 10_000),
      minSources: integer("ORACLE_MIN_SOURCES", 3, 1),
      maxWidthBps: integer("ORACLE_MAX_WIDTH_BPS", 100, 1, 10_000),
    },
    stable: {
      maxAgeMs,
      minSources: integer("ORACLE_STABLE_MIN_SOURCES", 2, 1),
      maxDepegBps: integer("ORACLE_STABLE_MAX_DEPEG_BPS", 500, 1, 10_000),
      usdcParBps: integer("ORACLE_USDC_PAR_BPS", 10, 0, 10_000),
    },
    candleRetentionMs: integer("ORACLE_CANDLE_RETENTION_HOURS", 24, 1, 24 * 90) * 3_600_000,
    host: env.ORACLE_HOST?.trim() || "127.0.0.1",
    port: integer("ORACLE_PORT", 4_900, 0, 65_535),
    corsOrigins: (env.ORACLE_CORS_ORIGINS ?? "")
      .split(",")
      .map((origin) => origin.trim())
      .filter(Boolean),
  };
}
