import { z } from "zod";
import { MARKETS } from "./markets.js";
export * from "./pricing.js";

export const quoteRequestSchema = z.object({
  market: z.enum(MARKETS),
  side: z.enum(["buy", "sell"]),
  amount: z.string().regex(/^\d+(\.\d{1,6})?$/),
});
