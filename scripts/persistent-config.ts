import { z } from "zod";
import { isSecureOrLoopbackUrl } from "../services/lib/src/auth.js";

const OFFICIAL_USDC = {
  "base-sepolia": "0x036cbd53842c5426634e7929541ec2318f3dcf7e",
  "base-mainnet": "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
} as const;
const CHAINS = { "base-sepolia": "84532", "base-mainnet": "8453" } as const;

/**
 * True when two RPC URLs name the same endpoint (scheme, host, port, path and query; a trailing slash
 * and host case are ignored). A secondary RPC that equals the primary is no independent check.
 */
export function rpcEndpointsMatch(first: string, second: string) {
  const normalize = (value: string) => {
    try {
      const url = new URL(value.trim());
      url.hash = "";
      return url.href.replace(/\/+$/, "");
    } catch {
      return value.trim().replace(/\/+$/, "");
    }
  };
  return normalize(first) === normalize(second);
}

export const persistentConfigSchema = z
  .object({
    environment: z.enum(["base-sepolia", "base-mainnet"]),
    chainId: z.enum(["84532", "8453"]),
    runtimeIdentity: z
      .object({
        oracleAddress: z.string(),
        oracleSigners: z.array(z.string()).min(1).max(16),
        oracleThreshold: z.number().int().min(1),
        governance: z.string(),
        emergencyCouncil: z.string(),
        implementationAddress: z.string(),
        riskMathAddress: z.string(),
        signatureVerifierAddress: z.string(),
        approvers: z.tuple([z.string(), z.string(), z.string()]),
        code: z
          .array(z.object({ address: z.string(), hash: z.string().regex(/^0x[0-9a-fA-F]{64}$/) }).strict())
          .min(6),
      })
      .strict(),
    rpcUrl: z
      .string()
      .url()
      .refine((value) => value.startsWith("https://"), "RPC must use HTTPS"),
    secondaryRpcUrl: z
      .string()
      .url()
      .refine((value) => value.startsWith("https://"), "secondary RPC must use HTTPS"),
    clearingAddress: z.string(),
    tokenAddress: z.string(),
    stateDirectory: z.string(),
    sponsorAddress: z.string().optional(),
    port: z.number().int().min(1024).max(65535),
    startBlock: z.number().int().nonnegative(),
    publicRpcUrl: z
      .string()
      .url()
      .refine((value) => value.startsWith("https://"), "public RPC must use HTTPS"),
    corsOrigin: z.string().url(),
    // The hedger trusts the indexer's fills and approvers trust the hedger's risk state: https off loopback.
    hedgeRiskUrl: z
      .string()
      .url()
      .refine(isSecureOrLoopbackUrl, "hedge risk URL must use HTTPS unless it is loopback"),
    indexerUrl: z
      .string()
      .url()
      .refine(isSecureOrLoopbackUrl, "indexer URL must use HTTPS unless it is loopback"),
    apiUrl: z.string().url(),
    /** Pyth feed ids: `[BTC, ETH]`, or a map from market symbol to feed id for any registered market. */
    feedIds: z.union([
      z.tuple([z.string(), z.string()]),
      z.record(z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,30}$/), z.string()),
    ]),
    approvers: z
      .array(z.object({ url: z.string().url(), token: z.string() }).strict())
      .length(3)
      .optional(),
    hedgeBandUsdc: z.string().regex(/^[1-9]\d*$/),
    hedgeMaxOrderUsdc: z.string().regex(/^[1-9]\d*$/),
    hedgeMinOrderUsdc: z.string().regex(/^[1-9]\d*$/),
    /** Maximum absolute venue position per market (USDC units); defaults to the contract's market ceiling. */
    hedgeMaxPositionUsdc: z
      .string()
      .regex(/^[1-9]\d*$/)
      .optional(),
    /**
     * Edge header carrying the end-user IP (set by Cloudflare). Services listen on loopback behind
     * the edge proxy, so without it every per-client budget keys on the proxy and acts as a global cap.
     */
    clientIpHeader: z.enum(["cf-connecting-ip"]).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.chainId !== CHAINS[value.environment])
      context.addIssue({ code: "custom", path: ["chainId"], message: "chain does not match environment" });
    if (value.tokenAddress.toLowerCase() !== OFFICIAL_USDC[value.environment])
      context.addIssue({
        code: "custom",
        path: ["tokenAddress"],
        message: "settlement token is not official USDC for environment",
      });
    // Approvers cross-check chain reads against the secondary RPC; on mainnet it must be independent.
    if (value.environment === "base-mainnet" && rpcEndpointsMatch(value.rpcUrl, value.secondaryRpcUrl))
      context.addIssue({
        code: "custom",
        path: ["secondaryRpcUrl"],
        message: "secondary RPC must differ from the primary RPC on base-mainnet",
      });
    if (BigInt(value.hedgeMinOrderUsdc) > BigInt(value.hedgeMaxOrderUsdc))
      context.addIssue({
        code: "custom",
        path: ["hedgeMinOrderUsdc"],
        message: "minimum hedge order exceeds maximum",
      });
  });

export type PersistentConfig = z.infer<typeof persistentConfigSchema>;
/** Feed ids keyed by market symbol (the legacy `[BTC, ETH]` tuple maps to the launch markets). */
export const feedIdsByMarket = (feedIds: PersistentConfig["feedIds"]): Record<string, string> =>
  Array.isArray(feedIds) ? { BTC: feedIds[0], ETH: feedIds[1] } : { ...feedIds };
export const hedgeVenueApiUrl = (environment: PersistentConfig["environment"]) =>
  environment === "base-mainnet" ? "https://api.hyperliquid.xyz" : "https://api.hyperliquid-testnet.xyz";
