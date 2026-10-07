import { z } from "zod";

const OFFICIAL_USDC = {
  "base-sepolia": "0x036cbd53842c5426634e7929541ec2318f3dcf7e",
  "base-mainnet": "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
} as const;
const CHAINS = { "base-sepolia": "84532", "base-mainnet": "8453" } as const;

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
    hedgeRiskUrl: z.string().url(),
    indexerUrl: z.string().url(),
    /** API: price fees at volume tiers read from indexerUrl. Enable only once every approver accepts tiers. */
    feeTiers: z.boolean().optional(),
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
