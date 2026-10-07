import { z } from "zod";
import { MARKETS } from "./markets.js";

const unsigned = z.string().regex(/^\d+$/),
  signed = z.string().regex(/^-?\d+$/),
  hex32 = z.string().regex(/^0x[0-9a-fA-F]{64}$/);

/** Complete, durable envelope sent to an independent maker approver. */
export const approverPayloadSchema = z.object({
  domain: z.object({
    name: z.string(),
    version: z.string(),
    chainId: unsigned,
    verifyingContract: z.string(),
  }),
  intent: z.object({
    account: z.string(),
    market: z.number().int().min(0).max(1),
    baseDelta: signed,
    limitPrice: unsigned,
    maxFee: unsigned,
    nonce: unsigned,
    deadline: unsigned,
    reduceOnly: z.boolean(),
  }),
  /** Present for a triggered order: the intent hash is then the `TriggeredTradeIntent` digest. */
  trigger: z.object({ triggerPrice: unsigned, triggerAbove: z.boolean() }).optional(),
  userSignature: z.string().regex(/^0x[0-9a-fA-F]+$/),
  approval: z.object({
    intentHash: hex32,
    executionPrice: unsigned,
    impactCharge: signed,
    fee: unsigned,
    oracleReportHash: hex32,
    deadline: unsigned,
    leaderEpoch: unsigned,
    signerSetVersion: unsigned,
    policyVersion: unsigned,
  }),
  quote: z.object({
    quoteId: z.string().uuid(),
    market: z.enum(MARKETS),
    side: z.enum(["buy", "sell"]),
    amount: unsigned,
    baseDelta: signed,
    expectedPrice: unsigned,
    worstPrice: unsigned,
    fee: unsigned,
    impactCharge: signed,
    spread: z
      .object({
        baseBps: unsigned,
        volatilityBps: unsigned,
        toxicityBps: unsigned,
        hedgeBps: unsigned,
        basisBps: unsigned,
        uncertaintyBps: unsigned,
        totalBps: unsigned,
        modelVersion: z.string(),
      })
      .optional(),
    expiresAtMs: z.number().int(),
    observedAtMs: z.number().int(),
    bid: unsigned,
    ask: unsigned,
  }),
  report: z.string().regex(/^0x[0-9a-fA-F]*$/),
  oracleAgeMs: z.number().nonnegative(),
});
export type ApproverPayload = z.infer<typeof approverPayloadSchema>;
