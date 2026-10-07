import { z } from "zod";
import { isKnownMarket, marketRegistry } from "./markets.js";

const integer = z.string().regex(/^\d+$/);
const usdcAmount = z.string().regex(/^\d+(\.\d{1,6})?$/);
const signature = z.string().regex(/^0x[0-9a-fA-F]+$/);
/** A market symbol the on-chain registry knows (refreshed from chain; see `marketRegistry`). */
const market = z.string().refine(isKnownMarket, "unknown market");
/** An on-chain market index below the registered market count. */
const marketId = z
  .number()
  .int()
  .min(0)
  .refine((value) => marketRegistry.hasIndex(value), "unknown market");
/**
 * A non-empty mask of registered markets, at most `(1 << marketCount) - 1`. A JSON number up to
 * 2^53 - 1, or a decimal string for masks above that (more than 53 markets).
 */
const marketMask = z
  .union([z.number().int().min(1).max(Number.MAX_SAFE_INTEGER), z.string().regex(/^[1-9]\d{0,38}$/)])
  .transform((value) => BigInt(value))
  .refine((value) => value > 0n && (value & ~marketRegistry.mask) === 0n, "unknown market in mask");
const durationSeconds = z.number().int().min(300).max(2_592_000);

export const intentRequestSchema = z.object({
  quoteId: z.string().uuid(),
  account: z.string(),
  nonce: integer,
  reduceOnly: z.boolean().default(false),
});
export const approvalRequestSchema = intentRequestSchema.extend({ userSignature: signature });
export type ApprovalRequest = z.infer<typeof approvalRequestSchema>;

/** Share of the position to close, in bps of its size (10_000 closes it all). */
const closeFraction = z.number().int().min(1).max(10_000).default(10_000);
export const closeQuoteSchema = z.object({ account: z.string(), market, fraction: closeFraction });
export const closeAllQuoteSchema = z.object({ account: z.string(), fraction: closeFraction });

export const depositQuoteSchema = z.object({
  account: z.string(),
  fromChainId: z.number().int().positive(),
  fromToken: z.enum(["USDC", "USDT", "ETH"]),
  amount: z.string().regex(/^\d+(\.\d{1,18})?$/),
});
export const depositExecuteSchema = z.object({
  routeId: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
  userSignature: signature,
});

const actionBaseSchema = z.object({ account: z.string(), nonce: integer });
const signedActionSchema = z.object({ userSignature: signature });

export const withdrawalPrepareSchema = actionBaseSchema.extend({
  recipient: z.string().optional(),
  amount: usdcAmount,
});
export const withdrawalExecuteSchema = signedActionSchema.extend({
  intent: z.object({
    account: z.string(),
    recipient: z.string(),
    amount: integer,
    nonce: integer,
    deadline: integer,
  }),
});

export const cancelPrepareSchema = actionBaseSchema;
export const cancelExecuteSchema = signedActionSchema.extend({
  intent: z.object({ account: z.string(), nonce: integer, deadline: integer }),
});

export const closePrepareSchema = actionBaseSchema.extend({ market });
export const closeExecuteSchema = signedActionSchema.extend({
  intent: z.object({
    account: z.string(),
    market: marketId,
    nonce: integer,
    deadline: integer,
  }),
});

export const sessionPrepareSchema = actionBaseSchema.extend({
  session: z.string(),
  marketMask,
  maxTradeAmount: usdcAmount,
  maxCumulativeAmount: usdcAmount,
  maxFee: usdcAmount,
  durationSeconds,
});
export const sessionExecuteSchema = signedActionSchema.extend({
  grant: z.object({
    account: z.string(),
    session: z.string(),
    marketMask,
    maxTradeNotional: integer,
    maxCumulativeNotional: integer,
    maxFee: integer,
    validUntil: integer,
    nonce: integer,
    deadline: integer,
  }),
});

export const orderPrepareSchema = z.object({
  account: z.string(),
  market,
  side: z.enum(["buy", "sell"]),
  amount: usdcAmount,
  limitPrice: usdcAmount,
  durationSeconds,
  nonce: integer,
  reduceOnly: z.boolean().default(false),
});
/** Slippage a triggered order allows past its trigger price; 1% by default. */
const triggerSlippageBps = z.number().int().min(1).max(500).default(100);

export const triggerOrderPrepareSchema = z.object({
  account: z.string(),
  market,
  kind: z.enum(["stop-loss", "take-profit", "stop-entry"]),
  /** Required for `amount` sizing; derived from the position (and checked if given) for `position`. */
  side: z.enum(["buy", "sell"]).optional(),
  /** `amount`: USDC notional at the trigger price. `position`: the whole current position, reduce-only. */
  sizing: z.enum(["amount", "position"]).default("amount"),
  amount: usdcAmount.optional(),
  triggerPrice: usdcAmount,
  /** Derived from kind and side; when given it must agree. */
  triggerAbove: z.boolean().optional(),
  slippageBps: triggerSlippageBps,
  durationSeconds,
  nonce: integer,
  /** Stop-loss and take-profit are always reduce-only; a stop entry defaults to opening. */
  reduceOnly: z.boolean().optional(),
});

export const tpslPrepareSchema = z
  .object({
    account: z.string(),
    market,
    takeProfitPrice: usdcAmount.optional(),
    stopLossPrice: usdcAmount.optional(),
    slippageBps: triggerSlippageBps,
    durationSeconds,
    nonce: integer,
  })
  .refine((value) => value.takeProfitPrice !== undefined || value.stopLossPrice !== undefined);

export const orderPlaceSchema = z.object({ orderId: z.string().uuid(), userSignature: signature });
