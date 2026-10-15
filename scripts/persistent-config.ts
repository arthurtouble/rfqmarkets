import { z } from "zod";
import { isSecureOrLoopbackUrl } from "../services/lib/src/auth.js";

const OFFICIAL_USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";

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
    environment: z.literal("base-mainnet"),
    chainId: z.literal("8453"),
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
    /**
     * The signed oracle: its node URLs and the adapter's agreement limits. Signers, threshold and the
     * adapter address come from `runtimeIdentity`, which startup checks against the chain.
     */
    oracle: z
      .object({
        nodes: z
          .array(
            z
              .string()
              .url()
              .refine((value) => value.startsWith("https://"), "oracle nodes must use HTTPS"),
          )
          .min(1)
          .max(16),
        maxDeviationBps: z.number().int().min(1).max(10_000),
        maxSkewSeconds: z.number().int().min(1).max(3_600),
      })
      .strict(),
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
    if (value.tokenAddress.toLowerCase() !== OFFICIAL_USDC)
      context.addIssue({
        code: "custom",
        path: ["tokenAddress"],
        message: "settlement token is not official USDC for environment",
      });
    // Approvers cross-check chain reads against the secondary RPC; it must be independent.
    if (rpcEndpointsMatch(value.rpcUrl, value.secondaryRpcUrl))
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
/** The production hedge venue; the host runs Base mainnet only. */
export const HEDGE_VENUE_API_URL = "https://api.hyperliquid.xyz";
