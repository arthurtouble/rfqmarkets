import { DatabaseSync } from "node:sqlite";
import {
  approverPayloadSchema,
  type ApproverPayload,
} from "../../../packages/shared/src/approver-payload.js";
import {
  bindGrossContext,
  finalizeGross,
  initializeGrossJournal,
  migrateGross,
  persistGross,
  persistLegacyGross,
  restoreGross,
} from "../../../packages/shared/src/gross-reservation-journal.js";
import {
  GrossReservationBook,
  type GrossReservation,
} from "../../../packages/shared/src/gross-reservations.js";

/** Expired approvals moved to the archive per finalization. */
const ARCHIVE_BATCH = 1024;

/**
 * Durable approver state: every signed approval with its full payload, the
 * archive of approvals expired before the finalized clock, and the gross
 * reservation journal that keeps escaped approvals' capacity reserved.
 */
export class ApprovalJournal {
  readonly gross = new GrossReservationBook();
  private readonly database: DatabaseSync;
  /** Latest expiry of a pre-payload (legacy) approval; such approvals cannot be re-reserved. */
  private readonly incompleteExpiryMs: number;

  /** `context` binds the journal to one chain, clearing contract and signer. */
  constructor(path: string, context: string) {
    this.database = new DatabaseSync(path);
    const database = this.database;
    database.exec(
      `PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS approvals(
        digest TEXT PRIMARY KEY, epoch INTEGER NOT NULL, expiry_ms INTEGER NOT NULL,
        signature TEXT NOT NULL, created_ms INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS archived_approvals(
        digest TEXT PRIMARY KEY, epoch INTEGER NOT NULL, expiry_ms INTEGER NOT NULL,
        signature TEXT NOT NULL, created_ms INTEGER NOT NULL, payload TEXT, archived_ms INTEGER NOT NULL)`,
    );
    const columns = database.prepare("PRAGMA table_info(approvals)").all() as Array<{ name: string }>;
    if (!columns.some((row) => row.name === "payload"))
      database.exec("ALTER TABLE approvals ADD COLUMN payload TEXT");
    initializeGrossJournal(database);
    bindGrossContext(database, "approver", context);
    migrateGross(database, "approver-v1", () => {
      for (const row of database.prepare("SELECT payload FROM approvals WHERE payload IS NOT NULL").all()) {
        const payload = approverPayloadSchema.parse(JSON.parse(String(row.payload)));
        persistLegacyGross(database, payload.approval.intentHash.toLowerCase(), {
          market: payload.intent.market as 0 | 1,
          baseDelta: BigInt(payload.intent.baseDelta),
          reduceOnly: payload.intent.reduceOnly,
          deadline: Number(payload.approval.deadline),
        });
      }
    });
    restoreGross(database, this.gross);
    const incomplete = database
      .prepare("SELECT MAX(expiry_ms) expiry FROM approvals WHERE payload IS NULL")
      .get() as { expiry: number | null };
    this.incompleteExpiryMs = Number(incomplete.expiry ?? -1);
  }

  /** A legacy approval without a payload may still execute; signing must wait until it expires. */
  get incompleteLegacy() {
    return this.incompleteExpiryMs >= this.gross.finalizedTimestamp * 1000;
  }

  /** Advance the finalized clock, releasing expired reservations and archiving expired approvals atomically. */
  finalize(block: number, timestamp: number, hash?: string) {
    finalizeGross(this.database, this.gross, block, timestamp, hash, () => this.archiveExpired(timestamp));
  }

  private archiveExpired(finalizedTimestamp: number) {
    const database = this.database,
      rows = database
        .prepare("SELECT digest FROM approvals WHERE expiry_ms<? ORDER BY expiry_ms,digest LIMIT ?")
        .all(finalizedTimestamp * 1000, ARCHIVE_BATCH) as Array<{ digest: string }>,
      archivedMs = Date.now(),
      move = database.prepare(
        "INSERT OR IGNORE INTO archived_approvals SELECT *,? FROM approvals WHERE digest=?",
      ),
      remove = database.prepare("DELETE FROM approvals WHERE digest=?");
    for (const row of rows) {
      move.run(archivedMs, row.digest);
      remove.run(row.digest);
    }
  }

  signatureFor(digest: string) {
    const row = this.database.prepare("SELECT signature FROM approvals WHERE digest = ?").get(digest) as
      { signature: string } | undefined;
    return row?.signature;
  }

  /**
   * Persist the gross reservation and the signed approval in one transaction,
   * then reserve in memory. Throws (after rolling back) on any journal failure.
   */
  commit(record: {
    digest: string;
    epoch: number;
    expiryMs: number;
    signature: string;
    createdMs: number;
    payload: ApproverPayload;
    grossId: string;
    grossItem: GrossReservation;
  }) {
    const database = this.database;
    database.exec("BEGIN IMMEDIATE");
    try {
      persistGross(database, record.grossId, record.grossItem);
      database
        .prepare(
          "INSERT INTO approvals (digest,epoch,expiry_ms,signature,created_ms,payload) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .run(
          record.digest,
          record.epoch,
          record.expiryMs,
          record.signature,
          record.createdMs,
          JSON.stringify(record.payload),
        );
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
    this.gross.reserve(record.grossId, record.grossItem);
  }

  /** Unexpired approvals with payloads and the gross journal, for signer replacement or repair. */
  recoveryExport(signer: string) {
    const database = this.database,
      cutoff = this.gross.finalizedTimestamp * 1000;
    return {
      signer,
      exportedAtMs: Date.now(),
      finalizedBlock: this.gross.finalizedBlock,
      finalizedTimestamp: this.gross.finalizedTimestamp,
      grossReservations: database.prepare("SELECT * FROM gross_reservations ORDER BY deadline,id").all(),
      approvals: database
        .prepare(
          "SELECT digest,epoch,expiry_ms,signature,payload FROM approvals WHERE expiry_ms>=? ORDER BY created_ms",
        )
        .all(cutoff),
      incomplete: database
        .prepare("SELECT count(*) count FROM approvals WHERE expiry_ms>=? AND payload IS NULL")
        .get(cutoff),
    };
  }

  close() {
    this.database.close();
  }
}
