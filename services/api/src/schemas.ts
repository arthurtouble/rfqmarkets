import { z } from "zod";

const integer = z.string().regex(/^\d+$/);
const usdcAmount = z.string().regex(/^\d+(\.\d{1,6})?$/);
const signature = z.string().regex(/^0x[0-9a-fA-F]+$/);
const market = z.enum(["BTC", "ETH"]);
const durationSeconds = z.number().int().min(300).max(2_592_000);

export const intentRequestSchema = z.object({
  quoteId: z.string().uuid(),
  account: z.string(),
  nonce: integer,
  reduceOnly: z.boolean().default(false),
});
export const approvalRequestSchema = intentRequestSchema.extend({ userSignature: signature });
export type ApprovalRequest = z.infer<typeof approvalRequestSchema>;

export const closeQuoteSchema = z.object({ account: z.string(), market });

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
    market: z.number().int().min(0).max(1),
    nonce: integer,
    deadline: integer,
  }),
});

export const sessionPrepareSchema = actionBaseSchema.extend({
  session: z.string(),
  marketMask: z.number().int().min(1).max(3),
  maxTradeAmount: usdcAmount,
  maxCumulativeAmount: usdcAmount,
  maxFee: usdcAmount,
  durationSeconds,
});
export const sessionExecuteSchema = signedActionSchema.extend({
  grant: z.object({
    account: z.string(),
    session: z.string(),
    marketMask: z.number().int().min(1).max(3),
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
export const orderPlaceSchema = z.object({ orderId: z.string().uuid(), userSignature: signature });
