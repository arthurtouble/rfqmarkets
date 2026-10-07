import type { DatabaseSync } from "node:sqlite";
import { getAddress, recoverAddress } from "ethers";
import { z } from "zod";
import { requestSchema } from "../services/approver/src/server.js";
import {
  DOMAIN_NAME,
  DOMAIN_VERSION,
  intentDigest,
  triggerFromWire,
  hashApproval,
  type SigningDomain,
  type TradeIntent,
  type MakerApproval,
} from "../packages/shared/src/eip712.js";
import { plausibleTriggeredFill } from "../services/approver/src/envelope.js";
import { persistGross } from "../packages/shared/src/gross-reservation-journal.js";
const schema = z.object({
  signer: z.string(),
  grossReservations: z
    .array(
      z.object({
        id: z.string(),
        market: z.number().int().min(0).max(1),
        base_delta: z.string(),
        reduce_only: z.number().int().min(0).max(1),
        deadline: z.number().int().nonnegative(),
        maker_debit: z.string().nullable(),
      }),
    )
    .max(50_000),
  approvals: z
    .array(
      z.object({
        digest: z.string(),
        epoch: z.number().int().nonnegative(),
        expiry_ms: z.number().int().nonnegative(),
        signature: z.string(),
        payload: z.string().nullable(),
      }),
    )
    .max(50_000),
});
/** Repairs a fenced existing signer journal only; never fabricates a complete empty recovery. */
export function importApproverRecovery(
  database: DatabaseSync,
  input: unknown,
  expected: { chainId: bigint; proxy: string; signer: string },
) {
  const data = schema.parse(input),
    signer = getAddress(expected.signer),
    proxy = getAddress(expected.proxy);
  if (getAddress(data.signer) !== signer) throw new Error("Recovery signer identity mismatch");
  const context = database.prepare("SELECT value FROM gross_context WHERE name='approver'").get() as
    { value: string } | undefined;
  if (context?.value !== `${expected.chainId}:${proxy.toLowerCase()}:${signer.toLowerCase()}`)
    throw new Error("Existing journal context required for recovery");
  const gross = new Map(data.grossReservations.map((row) => [row.id.toLowerCase(), row]));
  const records = data.approvals
    .filter((row) => row.payload !== null)
    .map((row) => {
      const payload = requestSchema.parse(JSON.parse(row.payload!));
      if (
        payload.domain.name !== DOMAIN_NAME ||
        payload.domain.version !== DOMAIN_VERSION ||
        BigInt(payload.domain.chainId) !== expected.chainId ||
        getAddress(payload.domain.verifyingContract) !== proxy
      )
        throw new Error("Recovery approval domain mismatch");
      const domain: SigningDomain = {
          name: DOMAIN_NAME,
          version: DOMAIN_VERSION,
          chainId: expected.chainId,
          verifyingContract: proxy,
        },
        intent: TradeIntent = {
          ...payload.intent,
          baseDelta: BigInt(payload.intent.baseDelta),
          limitPrice: BigInt(payload.intent.limitPrice),
          maxFee: BigInt(payload.intent.maxFee),
          nonce: BigInt(payload.intent.nonce),
          deadline: BigInt(payload.intent.deadline),
        },
        approval: MakerApproval = {
          ...payload.approval,
          executionPrice: BigInt(payload.approval.executionPrice),
          impactCharge: BigInt(payload.approval.impactCharge),
          fee: BigInt(payload.approval.fee),
          deadline: BigInt(payload.approval.deadline),
          leaderEpoch: BigInt(payload.approval.leaderEpoch),
          signerSetVersion: BigInt(payload.approval.signerSetVersion),
          policyVersion: BigInt(payload.approval.policyVersion),
        };
      const trigger = payload.trigger ? triggerFromWire(payload.trigger) : undefined,
        fillDelta = trigger ? BigInt(payload.quote.baseDelta) : intent.baseDelta;
      if (trigger && !plausibleTriggeredFill(intent, fillDelta))
        throw new Error("Recovery triggered fill is inconsistent");
      if (
        intentDigest(domain, intent, trigger).toLowerCase() !== approval.intentHash.toLowerCase() ||
        hashApproval(domain, approval).toLowerCase() !== row.digest.toLowerCase() ||
        recoverAddress(row.digest, row.signature) !== signer ||
        approval.deadline > intent.deadline ||
        BigInt(row.expiry_ms) !== approval.deadline * 1000n ||
        BigInt(row.epoch) !== approval.leaderEpoch
      )
        throw new Error("Recovery signature/payload binding failed");
      const reservation = gross.get(approval.intentHash.toLowerCase());
      if (
        !reservation ||
        reservation.maker_debit === null ||
        reservation.market !== intent.market ||
        reservation.base_delta !== fillDelta.toString() ||
        Boolean(reservation.reduce_only) !== intent.reduceOnly ||
        reservation.deadline < Number(approval.deadline)
      )
        throw new Error("Recovery capital reservation is incomplete");
      return { row, payload, intent, approval, reservation, fillDelta };
    });
  database.exec("BEGIN IMMEDIATE");
  try {
    for (const { row, payload, intent, approval, reservation, fillDelta } of records) {
      const prior = database
        .prepare("SELECT signature,payload FROM approvals WHERE digest=?")
        .get(row.digest) as { signature: string; payload: string | null } | undefined;
      if (
        prior &&
        (prior.signature !== row.signature ||
          (prior.payload !== null &&
            JSON.stringify(requestSchema.parse(JSON.parse(prior.payload))) !== JSON.stringify(payload)))
      )
        throw new Error("Recovery conflicts with existing approval");
      database
        .prepare(
          "INSERT INTO approvals(digest,epoch,expiry_ms,signature,created_ms,payload) VALUES(?,?,?,?,?,?) ON CONFLICT(digest) DO UPDATE SET payload=COALESCE(payload,excluded.payload)",
        )
        .run(row.digest, row.epoch, row.expiry_ms, row.signature, Date.now(), JSON.stringify(payload));
      persistGross(database, approval.intentHash.toLowerCase(), {
        market: intent.market as 0 | 1,
        baseDelta: fillDelta,
        reduceOnly: intent.reduceOnly,
        deadline: Number(approval.deadline),
        makerDebit: BigInt(reservation.maker_debit!),
      });
    }
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
  return {
    imported: records.length,
    incompleteExport: data.approvals.length - records.length,
    incompleteJournal: Number(
      (
        database.prepare("SELECT COUNT(*) count FROM approvals WHERE payload IS NULL").get() as {
          count: number;
        }
      ).count,
    ),
  };
}
