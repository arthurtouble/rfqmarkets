import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GrossReservationBook } from "../../../packages/shared/src/gross-reservations.js";
import { RETENTION_MS } from "../../../packages/shared/src/retention.js";
import { openApiJournal, pruneApiJournal } from "./journal.js";

test("pruning deletes archived records and finished orders past retention only", () => {
  const directory = mkdtempSync(join(tmpdir(), "rfq-journal-")),
    journal = openApiJournal(join(directory, "api.sqlite"), "test", new GrossReservationBook()),
    now = Date.now(),
    old = now - RETENTION_MS - 1;
  try {
    const archive = journal.prepare(
        "INSERT INTO archived_commitments VALUES(?,'BTC','1',0,'settled','{}','0x',NULL,NULL,0,?)",
      ),
      artifact = journal.prepare("INSERT INTO archived_approval_artifacts VALUES(?,?,'{}',0,?)"),
      order = journal.prepare(
        "INSERT INTO resting_orders(order_id,account,market,side,amount,intent_json,user_signature,status,created_ms,updated_ms) VALUES(?,'0x1','BTC','buy','1','{}','0x',?,0,?)",
      );
    archive.run("old", old);
    archive.run("recent", now);
    artifact.run("old", "old", old);
    artifact.run("recent", "recent", now);
    order.run("filled-old", "filled", old);
    order.run("open-old", "open", old);
    order.run("cancelled-recent", "cancelled", now);
    pruneApiJournal(journal, now);
    const ids = (sql: string) =>
      journal
        .prepare(sql)
        .all()
        .map((row) => Object.values(row)[0]);
    assert.deepEqual(ids("SELECT quote_id FROM archived_commitments"), ["recent"]);
    assert.deepEqual(ids("SELECT digest FROM archived_approval_artifacts"), ["recent"]);
    assert.deepEqual(ids("SELECT order_id FROM resting_orders ORDER BY order_id"), [
      "cancelled-recent",
      "open-old",
    ]);
  } finally {
    journal.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
