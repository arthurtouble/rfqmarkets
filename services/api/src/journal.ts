import { DatabaseSync } from "node:sqlite";
import type { GrossReservationBook } from "../../../packages/shared/src/gross-reservations.js";
import {
  bindGrossContext,
  initializeGrossJournal,
  migrateGross,
  persistLegacyGross,
  restoreGross,
} from "../../../packages/shared/src/gross-reservation-journal.js";
import type { PendingExposureBook } from "./bounded-state.js";
import type { FlowFill } from "./flow-risk.js";
import type { Market, Side } from "./markets.js";
import { initializeApiRecoveryJournal } from "./recovery.js";

/** Paid-flow evidence older than this no longer informs the toxicity score. */
export const FLOW_FILL_RETENTION_MS = 240_000;

const SCHEMA = `
PRAGMA journal_mode=WAL;
CREATE TABLE IF NOT EXISTS commitments (
  quote_id TEXT PRIMARY KEY, market TEXT NOT NULL, delta TEXT NOT NULL, expires_ms INTEGER NOT NULL,
  status TEXT NOT NULL, intent_json TEXT NOT NULL, user_signature TEXT NOT NULL, approval_json TEXT,
  tx_hash TEXT, updated_ms INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS resting_orders (
  order_id TEXT PRIMARY KEY, account TEXT NOT NULL, market TEXT NOT NULL, side TEXT NOT NULL,
  amount TEXT NOT NULL, intent_json TEXT NOT NULL, user_signature TEXT NOT NULL, status TEXT NOT NULL,
  created_ms INTEGER NOT NULL, updated_ms INTEGER NOT NULL, tx_hash TEXT, last_error TEXT);
CREATE TABLE IF NOT EXISTS flow_fills (
  fill_id TEXT PRIMARY KEY, market TEXT NOT NULL, side TEXT NOT NULL, price TEXT NOT NULL,
  notional TEXT NOT NULL, filled_ms INTEGER NOT NULL);
`;

/** Open the leader journal, create its tables and restore durable gross reservations. */
export function openApiJournal(path: string, grossContext: string, grossReservations: GrossReservationBook) {
  const journal = new DatabaseSync(path);
  journal.exec(SCHEMA);
  migrateRestingOrders(journal);
  initializeApiRecoveryJournal(journal);
  initializeGrossJournal(journal);
  bindGrossContext(journal, "api", grossContext);
  migrateGross(journal, "api-v1", () => {
    for (const row of journal.prepare("SELECT quote_id,intent_json FROM commitments").all()) {
      const item = row as { quote_id: string; intent_json: string },
        intent = JSON.parse(item.intent_json);
      persistLegacyGross(journal, item.quote_id, {
        market: intent.market,
        baseDelta: BigInt(intent.baseDelta),
        reduceOnly: intent.reduceOnly,
        deadline: Number(intent.deadline),
      });
    }
  });
  restoreGross(journal, grossReservations);
  return journal;
}

/**
 * Trigger orders (stop-loss, take-profit, stop entry) share `resting_orders` with limit orders:
 * `order_type` names the kind and `trigger_json` holds the signed trigger and its order metadata.
 * Journals written before trigger orders gain both columns; their rows are limit orders.
 */
function migrateRestingOrders(journal: DatabaseSync) {
  const columns = journal.prepare("PRAGMA table_info(resting_orders)").all() as Array<{ name: string }>;
  if (!columns.some((column) => column.name === "order_type"))
    journal.exec("ALTER TABLE resting_orders ADD COLUMN order_type TEXT NOT NULL DEFAULT 'limit'");
  if (!columns.some((column) => column.name === "trigger_json"))
    journal.exec("ALTER TABLE resting_orders ADD COLUMN trigger_json TEXT");
}

export function restoreFlowFills(journal: DatabaseSync | undefined, now = Date.now()): FlowFill[] {
  const rows =
    journal
      ?.prepare(
        "SELECT market,side,price,notional,filled_ms FROM flow_fills WHERE filled_ms>? ORDER BY filled_ms DESC LIMIT 512",
      )
      .all(now - FLOW_FILL_RETENTION_MS) ?? [];
  return rows.reverse().map((row) => {
    const item = row as { market: Market; side: Side; price: string; notional: string; filled_ms: number };
    return {
      market: item.market,
      side: item.side,
      price: BigInt(item.price),
      notional: BigInt(item.notional),
      atMs: item.filled_ms,
    };
  });
}

/** Unexpired commitments keep pricing the inventory they may still add after a restart. */
export function restorePendingCommitments(
  journal: DatabaseSync | undefined,
  pending: PendingExposureBook,
  now = Date.now(),
) {
  const rows =
    journal
      ?.prepare(
        "SELECT quote_id, market, delta, expires_ms FROM commitments WHERE status IN ('reserved','approved','submitted','ambiguous') AND expires_ms > ?",
      )
      .all(now) ?? [];
  for (const row of rows) {
    const item = row as { quote_id: string; market: Market; delta: string; expires_ms: number };
    pending.add(item.quote_id, {
      market: item.market,
      delta: BigInt(item.delta),
      expiresAtMs: item.expires_ms,
    });
  }
}

export function recordFlowFill(
  journal: DatabaseSync | undefined,
  fillId: string,
  fill: FlowFill & { market: Market },
) {
  journal
    ?.prepare("INSERT OR IGNORE INTO flow_fills VALUES (?,?,?,?,?,?)")
    .run(fillId, fill.market, fill.side, fill.price.toString(), fill.notional.toString(), fill.atMs);
  journal?.prepare("DELETE FROM flow_fills WHERE filled_ms<?").run(fill.atMs - FLOW_FILL_RETENTION_MS);
}
