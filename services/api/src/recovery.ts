import type { DatabaseSync } from "node:sqlite";
import { getAddress } from "ethers";
import { approverPayloadSchema } from "../../../packages/shared/src/approver-payload.js";
import {
  DOMAIN_NAME,
  DOMAIN_VERSION,
  hashApproval,
  hashIntent,
  type MakerApproval,
  type SigningDomain,
  type TradeIntent,
} from "../../../packages/shared/src/eip712.js";
import type { Quote } from "../../../packages/shared/src/policy.js";

type CommitmentRow = {
  quote_id: string;
  market: "BTC" | "ETH";
  delta: string;
  expires_ms: number;
  status: string;
  intent_json: string;
  user_signature: string;
  approval_json: string | null;
};
export type RecoveredCommitment = { quote: Quote; intent: TradeIntent; userSignature: string };

const toIntent = (wire: ReturnType<typeof approverPayloadSchema.parse>["intent"]): TradeIntent => ({
  ...wire,
  account: getAddress(wire.account),
  baseDelta: BigInt(wire.baseDelta),
  limitPrice: BigInt(wire.limitPrice),
  maxFee: BigInt(wire.maxFee),
  nonce: BigInt(wire.nonce),
  deadline: BigInt(wire.deadline),
});
const toApproval = (wire: ReturnType<typeof approverPayloadSchema.parse>["approval"]): MakerApproval => ({
  ...wire,
  executionPrice: BigInt(wire.executionPrice),
  impactCharge: BigInt(wire.impactCharge),
  fee: BigInt(wire.fee),
  deadline: BigInt(wire.deadline),
  leaderEpoch: BigInt(wire.leaderEpoch),
  signerSetVersion: BigInt(wire.signerSetVersion),
  policyVersion: BigInt(wire.policyVersion),
});

export function initializeApiRecoveryJournal(database: DatabaseSync) {
  database.exec(
    "CREATE TABLE IF NOT EXISTS approval_artifacts(digest TEXT PRIMARY KEY,quote_id TEXT NOT NULL,payload TEXT NOT NULL,created_ms INTEGER NOT NULL);CREATE INDEX IF NOT EXISTS approval_artifacts_quote ON approval_artifacts(quote_id,created_ms);CREATE TABLE IF NOT EXISTS archived_commitments(quote_id TEXT PRIMARY KEY,market TEXT NOT NULL,delta TEXT NOT NULL,expires_ms INTEGER NOT NULL,status TEXT NOT NULL,intent_json TEXT NOT NULL,user_signature TEXT NOT NULL,approval_json TEXT,tx_hash TEXT,updated_ms INTEGER NOT NULL,archived_ms INTEGER NOT NULL);CREATE TABLE IF NOT EXISTS archived_approval_artifacts(digest TEXT PRIMARY KEY,quote_id TEXT NOT NULL,payload TEXT NOT NULL,created_ms INTEGER NOT NULL,archived_ms INTEGER NOT NULL)",
  );
}

/** Restore only complete signed envelopes. A partial active record is a readiness failure. */
export function restoreApiCommitments(
  database: DatabaseSync,
  domain: SigningDomain,
  nowMs = Date.now(),
): RecoveredCommitment[] {
  const rows = database
    .prepare(
      "SELECT quote_id,market,delta,expires_ms,status,intent_json,user_signature,approval_json FROM commitments WHERE status IN ('reserved','approved','submitted','ambiguous') AND expires_ms>?",
    )
    .all(nowMs) as unknown as CommitmentRow[];
  return rows.map((row) => {
    if (!row.approval_json) throw new Error(`incomplete API recovery record ${row.quote_id}`);
    const artifacts = database
      .prepare("SELECT digest,payload FROM approval_artifacts WHERE quote_id=? ORDER BY created_ms DESC")
      .all(row.quote_id) as Array<{ digest: string; payload: string }>;
    let selected: ReturnType<typeof approverPayloadSchema.parse> | undefined;
    for (const artifact of artifacts) {
      let payload: ReturnType<typeof approverPayloadSchema.parse>;
      try {
        payload = approverPayloadSchema.parse(JSON.parse(artifact.payload));
      } catch {
        continue;
      }
      const payloadDomain: SigningDomain = {
        ...payload.domain,
        chainId: BigInt(payload.domain.chainId),
        verifyingContract: getAddress(payload.domain.verifyingContract),
      };
      const approval = toApproval(payload.approval);
      if (
        payloadDomain.name !== DOMAIN_NAME ||
        payloadDomain.version !== DOMAIN_VERSION ||
        payloadDomain.chainId !== domain.chainId ||
        payloadDomain.verifyingContract !== domain.verifyingContract ||
        hashApproval(payloadDomain, approval).toLowerCase() !== artifact.digest.toLowerCase()
      )
        continue;
      const storedApproval = approverPayloadSchema.shape.approval.safeParse(JSON.parse(row.approval_json));
      if (
        !storedApproval.success ||
        hashApproval(domain, toApproval(storedApproval.data)) !== artifact.digest
      )
        continue;
      selected = payload;
      break;
    }
    if (!selected) throw new Error(`missing or inconsistent API approval artifact ${row.quote_id}`);
    const intent = toIntent(selected.intent),
      approval = toApproval(selected.approval),
      market = selected.quote.market === "BTC" ? 0 : 1,
      notional = BigInt(selected.quote.amount),
      expectedDelta = selected.quote.side === "buy" ? notional : -notional;
    const storedIntent = approverPayloadSchema.shape.intent.safeParse(JSON.parse(row.intent_json));
    const gross = database
      .prepare("SELECT market,base_delta,reduce_only,deadline FROM gross_reservations WHERE id=?")
      .get(row.quote_id) as
      { market: number; base_delta: string; reduce_only: number; deadline: number } | undefined;
    if (
      !storedIntent.success ||
      JSON.stringify(storedIntent.data) !== JSON.stringify(selected.intent) ||
      selected.userSignature !== row.user_signature ||
      selected.quote.quoteId !== row.quote_id ||
      selected.quote.market !== row.market ||
      selected.quote.baseDelta !== selected.intent.baseDelta ||
      expectedDelta.toString() !== row.delta ||
      intent.market !== market ||
      approval.intentHash.toLowerCase() !== hashIntent(domain, intent).toLowerCase() ||
      Number(intent.deadline) * 1000 !== row.expires_ms ||
      !gross ||
      gross.market !== intent.market ||
      gross.base_delta !== intent.baseDelta.toString() ||
      gross.reduce_only !== Number(intent.reduceOnly) ||
      gross.deadline < Number(approval.deadline)
    )
      throw new Error(`inconsistent API recovery record ${row.quote_id}`);
    const spread = selected.quote.spread && {
      ...selected.quote.spread,
      baseBps: BigInt(selected.quote.spread.baseBps),
      volatilityBps: BigInt(selected.quote.spread.volatilityBps),
      toxicityBps: BigInt(selected.quote.spread.toxicityBps),
      hedgeBps: BigInt(selected.quote.spread.hedgeBps),
      basisBps: BigInt(selected.quote.spread.basisBps),
      uncertaintyBps: BigInt(selected.quote.spread.uncertaintyBps),
      totalBps: BigInt(selected.quote.spread.totalBps),
    };
    const quote: Quote = {
      quoteId: row.quote_id,
      market: row.market,
      side: selected.quote.side,
      notional,
      delta: expectedDelta,
      baseDelta: BigInt(selected.quote.baseDelta),
      expectedPrice: BigInt(selected.quote.expectedPrice),
      worstPrice: BigInt(selected.quote.worstPrice),
      fee: BigInt(selected.quote.fee),
      impactCharge: BigInt(selected.quote.impactCharge),
      spread,
      expiresAtMs: row.expires_ms,
      snapshot: {
        market: row.market,
        bid: BigInt(selected.quote.bid),
        ask: BigInt(selected.quote.ask),
        observedAtMs: selected.quote.observedAtMs,
      },
    };
    return { quote, intent, userSignature: row.user_signature };
  });
}

/** Move records only after the gross journal released them using finalized time. */
export function archiveApiCommitments(
  database: DatabaseSync,
  quoteIds: string[],
  archivedMs = Date.now(),
  manageTransaction = true,
) {
  if (!quoteIds.length) return;
  if (manageTransaction) database.exec("BEGIN IMMEDIATE");
  try {
    const moveCommitment = database.prepare(
      "INSERT OR REPLACE INTO archived_commitments SELECT *,? FROM commitments WHERE quote_id=?",
    );
    const moveArtifacts = database.prepare(
      "INSERT OR IGNORE INTO archived_approval_artifacts SELECT *,? FROM approval_artifacts WHERE quote_id=?",
    );
    const deleteArtifacts = database.prepare("DELETE FROM approval_artifacts WHERE quote_id=?"),
      deleteCommitment = database.prepare("DELETE FROM commitments WHERE quote_id=?");
    for (const id of quoteIds) {
      moveCommitment.run(archivedMs, id);
      moveArtifacts.run(archivedMs, id);
      deleteArtifacts.run(id);
      deleteCommitment.run(id);
    }
    if (manageTransaction) database.exec("COMMIT");
  } catch (error) {
    if (manageTransaction) database.exec("ROLLBACK");
    throw error;
  }
}
