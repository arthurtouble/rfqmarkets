import { z } from "zod";

const decimal = (precision: number) => z.string().regex(new RegExp(`^\\d+(\\.\\d{1,${precision}})?$`));
const unsignedInteger = z.string().regex(/^\d+$/);
const signature = z.string().regex(/^0x[0-9a-fA-F]+$/);
const market = z.enum(["BTC", "ETH"]);

export const intentRequestSchema = z.object({
  quoteId: z.string().uuid(),
  account: z.string(),
  nonce: unsignedInteger,
  reduceOnly: z.boolean().default(false),
});
export const approvalRequestSchema = intentRequestSchema.extend({ userSignature: signature });

export const depositQuoteSchema = z.object({
  account: z.string(),
  fromChainId: z.number().int().positive(),
  fromToken: z.enum(["USDC", "USDT", "ETH"]),
  amount: decimal(18),
});
export const depositExecuteSchema = z.object({
  routeId: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
  userSignature: signature,
});

export const actionBaseSchema = z.object({ account: z.string(), nonce: unsignedInteger });
export const signedActionSchema = z.object({ userSignature: signature });
export const withdrawalPrepareSchema = actionBaseSchema.extend({ recipient: z.string().optional(), amount: decimal(6) });
export const withdrawalExecuteSchema = signedActionSchema.extend({
  intent: z.object({ account: z.string(), recipient: z.string(), amount: unsignedInteger, nonce: unsignedInteger, deadline: unsignedInteger }),
});
export const cancelExecuteSchema = signedActionSchema.extend({
  intent: z.object({ account: z.string(), nonce: unsignedInteger, deadline: unsignedInteger }),
});
export const closePrepareSchema = actionBaseSchema.extend({ market });
export const closeExecuteSchema = signedActionSchema.extend({
  intent: z.object({ account: z.string(), market: z.number().int().min(0).max(1), nonce: unsignedInteger, deadline: unsignedInteger }),
});
export const closeQuoteSchema = z.object({ account: z.string(), market });

export const sessionPrepareSchema = actionBaseSchema.extend({
  session: z.string(),
  marketMask: z.number().int().min(1).max(3),
  maxTradeAmount: decimal(6),
  maxCumulativeAmount: decimal(6),
  maxFee: decimal(6),
  durationSeconds: z.number().int().min(300).max(2_592_000),
});
export const sessionExecuteSchema = signedActionSchema.extend({
  grant: z.object({
    account: z.string(), session: z.string(), marketMask: z.number().int().min(1).max(3),
    maxTradeNotional: unsignedInteger, maxCumulativeNotional: unsignedInteger, maxFee: unsignedInteger,
    validUntil: unsignedInteger, nonce: unsignedInteger, deadline: unsignedInteger,
  }),
});

export const orderPrepareSchema = z.object({
  account: z.string(), market, side: z.enum(["buy", "sell"]), amount: decimal(6), limitPrice: decimal(6),
  durationSeconds: z.number().int().min(300).max(2_592_000), nonce: unsignedInteger, reduceOnly: z.boolean().default(false),
});
export const orderPlaceSchema = z.object({ orderId: z.string().uuid(), userSignature: signature });
