import { z } from "zod";
import { isKnownMarket } from "./markets.js";
import { MAX_SLIPPAGE_BPS, MIN_SLIPPAGE_BPS } from "./pricing.js";
export * from "./pricing.js";

export const quoteRequestSchema = z.object({
  market: z.string().refine(isKnownMarket, "unknown market"),
  side: z.enum(["buy", "sell"]),
  amount: z.string().regex(/^\d+(\.\d{1,6})?$/),
  /** Optional price protection in bps; the default is the launch tolerance (8 bps). */
  slippageBps: z.number().int().min(MIN_SLIPPAGE_BPS).max(MAX_SLIPPAGE_BPS).optional(),
});
