import type { DatabaseSync } from "node:sqlite";
import { GrossReservationBook, assertGrossReservation, type GrossReservation } from "./gross-reservations.js";
export function initializeGrossJournal(database: DatabaseSync) {
  database.exec(
    "CREATE TABLE IF NOT EXISTS gross_reservations(id TEXT PRIMARY KEY,market INTEGER NOT NULL,base_delta TEXT NOT NULL,reduce_only INTEGER NOT NULL,deadline INTEGER NOT NULL,maker_debit TEXT);CREATE INDEX IF NOT EXISTS gross_deadlines ON gross_reservations(deadline);CREATE TABLE IF NOT EXISTS gross_migrations(name TEXT PRIMARY KEY);CREATE TABLE IF NOT EXISTS gross_context(name TEXT PRIMARY KEY,value TEXT NOT NULL);CREATE TABLE IF NOT EXISTS gross_clock(singleton INTEGER PRIMARY KEY CHECK(singleton=1),block INTEGER NOT NULL,timestamp INTEGER NOT NULL,hash TEXT)",
  );
  if (
    !(database.prepare("PRAGMA table_info(gross_reservations)").all() as Array<{ name: string }>).some(
      (row) => row.name === "maker_debit",
    )
  )
    database.exec("ALTER TABLE gross_reservations ADD COLUMN maker_debit TEXT");
}
export function persistGross(database: DatabaseSync, id: string, item: GrossReservation) {
  assertGrossReservation(item);
  const result = database
    .prepare(
      "INSERT INTO gross_reservations(id,market,base_delta,reduce_only,deadline,maker_debit) VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET deadline=MAX(deadline,excluded.deadline) WHERE market=excluded.market AND base_delta=excluded.base_delta AND reduce_only=excluded.reduce_only AND maker_debit=excluded.maker_debit",
    )
    .run(
      id,
      item.market,
      item.baseDelta.toString(),
      Number(item.reduceOnly),
      item.deadline,
      item.makerDebit.toString(),
    );
  if (result.changes !== 1) throw new Error("gross journal input mismatch");
}
export function persistLegacyGross(
  database: DatabaseSync,
  id: string,
  item: Omit<GrossReservation, "makerDebit">,
) {
  const result = database
    .prepare(
      "INSERT OR IGNORE INTO gross_reservations(id,market,base_delta,reduce_only,deadline,maker_debit) VALUES(?,?,?,?,?,NULL)",
    )
    .run(id, item.market, item.baseDelta.toString(), Number(item.reduceOnly), item.deadline);
  if (result.changes !== 0 && result.changes !== 1) throw new Error("legacy gross journal write failed");
}
export function restoreGross(database: DatabaseSync, book: GrossReservationBook) {
  for (const row of database.prepare("SELECT * FROM gross_reservations").all()) {
    const item = row as {
      id: string;
      market: 0 | 1;
      base_delta: string;
      reduce_only: number;
      deadline: number;
      maker_debit: string | null;
    };
    if (
      (item.reduce_only !== 0 && item.reduce_only !== 1) ||
      (item.maker_debit === null && item.reduce_only === 0)
    )
      throw new Error("legacy gross capital reservation is incomplete");
    book.reserve(item.id, {
      market: item.market,
      baseDelta: BigInt(item.base_delta),
      reduceOnly: item.reduce_only === 1,
      deadline: item.deadline,
      makerDebit: BigInt(item.maker_debit ?? 0),
    });
  }
  const clock = database.prepare("SELECT block,timestamp,hash FROM gross_clock WHERE singleton=1").get() as
    { block: number; timestamp: number; hash: string | null } | undefined;
  if (clock) book.finalize(clock.block, clock.timestamp, 0, clock.hash ?? undefined);
}
export function migrateGross(database: DatabaseSync, name: string, backfill: () => void) {
  if (database.prepare("SELECT 1 FROM gross_migrations WHERE name=?").get(name)) return;
  database.exec("BEGIN IMMEDIATE");
  try {
    backfill();
    database.prepare("INSERT INTO gross_migrations VALUES(?)").run(name);
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}
export function finalizeGross(
  database: DatabaseSync | undefined,
  book: GrossReservationBook,
  block: number,
  timestamp: number,
  hash?: string,
  onExpired?: (ids: string[]) => void,
) {
  // Commit durable release/archive first. A failed transaction restores the heap and leaves in-memory capacity reserved.
  return book.finalize(
    block,
    timestamp,
    512,
    hash,
    database
      ? (expired, finalizedHash) => {
          database.exec("BEGIN IMMEDIATE");
          try {
            database
              .prepare(
                "INSERT INTO gross_clock VALUES(1,?,?,?) ON CONFLICT(singleton) DO UPDATE SET block=excluded.block,timestamp=excluded.timestamp,hash=excluded.hash",
              )
              .run(block, timestamp, finalizedHash ?? null);
            const remove = database.prepare("DELETE FROM gross_reservations WHERE id=? AND deadline<?");
            for (const id of expired) remove.run(id, timestamp);
            onExpired?.(expired);
            database.exec("COMMIT");
          } catch (error) {
            database.exec("ROLLBACK");
            throw error;
          }
        }
      : undefined,
  );
}

export function bindGrossContext(database: DatabaseSync, name: string, value: string) {
  const existing = database.prepare("SELECT value FROM gross_context WHERE name=?").get(name) as
    { value: string } | undefined;
  if (existing) {
    if (existing.value !== value) throw new Error("gross journal signing context mismatch");
  } else database.prepare("INSERT INTO gross_context VALUES(?,?)").run(name, value);
}
