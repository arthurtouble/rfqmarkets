import { z } from "zod";
export * from "./pricing.js";

export const quoteRequestSchema = z.object({
  market: z.enum(["BTC", "ETH"]),
  side: z.enum(["buy", "sell"]),
  amount: z.string().regex(/^\d+(\.\d{1,6})?$/),
});

export type QuoteRequest = z.infer<typeof quoteRequestSchema>;
