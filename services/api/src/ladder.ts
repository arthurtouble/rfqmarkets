import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { isKnownMarket, type Market } from "../../../packages/shared/src/markets.js";
import { formatUsdc } from "../../../packages/shared/src/policy.js";
import type { HttpGuards } from "./http.js";
import { publicError } from "./public-error.js";
import type { QuoteEngine } from "./quoting.js";

/** Default sizes, in USDC notional, when the request names none. */
export const DEFAULT_LADDER_AMOUNTS = ["1000", "10000", "50000", "100000"] as const;
export const MAX_LADDER_SIZES = 6;

export const ladderQuerySchema = z.object({
  market: z.string().refine(isKnownMarket, "unknown market"),
  /** Comma-separated USDC amounts, e.g. `1000,10000`; at most six. */
  amounts: z
    .string()
    .regex(/^\d+(\.\d{1,6})?(,\d+(\.\d{1,6})?)*$/)
    .optional(),
});

/** One rung: the price a firm quote of `amount` would get now, and what makes it up. */
export type LadderRung = {
  amount: string;
  /** Average execution price, USDC micro-units per base unit. */
  price: string;
  /** Execution price vs the oracle mid, in bps (always a cost: positive for buys and sells). */
  costBps: string;
  impactCharge: string;
  fee: string;
};

/**
 * Indicative depth for RFQ: buy and sell prices at several sizes, priced exactly like a firm quote but not
 * stored, so nothing can be prepared or approved from it. A side stops at the first size the venue cannot fill
 * now; when neither side can quote at all (no price, venue closed), the ladder is unavailable.
 */
export function registerLadderRoutes(app: FastifyInstance, guards: HttpGuards, quoting: QuoteEngine) {
  app.get("/v1/quote/ladder", async (request, reply) => {
    if (!guards.admitQuoteWork(request, reply)) return;
    const parsed = ladderQuerySchema.safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ error: "invalid ladder request" });
    const amounts = parsed.data.amounts?.split(",") ?? [...DEFAULT_LADDER_AMOUNTS];
    if (amounts.length > MAX_LADDER_SIZES || amounts.some((amount) => Number(amount) <= 0))
      return reply.code(400).send({ error: "invalid ladder request" });
    const market = parsed.data.market as Market;
    let failure: unknown;
    try {
      const side = async (direction: "buy" | "sell") => {
        const rungs: LadderRung[] = [];
        let mid: bigint | undefined;
        // Sequential: each indicative quote reads the same cached market snapshot.
        for (const amount of amounts) {
          try {
            const { quote } = await quoting.createQuote(
              { market, side: direction, amount },
              { persist: false },
            );
            mid = (quote.snapshot.bid + quote.snapshot.ask) / 2n;
            const cost = direction === "buy" ? quote.expectedPrice - mid : mid - quote.expectedPrice;
            rungs.push({
              amount: formatUsdc(quote.notional),
              price: quote.expectedPrice.toString(),
              costBps: ((cost * 10_000n) / mid).toString(),
              impactCharge: quote.impactCharge.toString(),
              fee: quote.fee.toString(),
            });
          } catch (error) {
            // A size the venue cannot fill (trade limit, hedge admission) ends the side.
            failure = error;
            break;
          }
        }
        return { rungs, mid };
      };
      const buy = await side("buy"),
        sell = await side("sell");
      if (!buy.rungs.length && !sell.rungs.length) throw failure;
      return { market, mid: (buy.mid ?? sell.mid)?.toString() ?? null, buy: buy.rungs, sell: sell.rungs };
    } catch (error) {
      return reply.code(503).send({ error: publicError(error, "ladder unavailable") });
    }
  });
}
