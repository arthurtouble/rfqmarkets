import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BASE } from "../../../packages/shared/src/numeric.js";
import { ApprovalJournal } from "./journal.js";
import { buildFixture } from "./test-fixtures.js";

const directory = mkdtempSync(join(tmpdir(), "rfq-approver-journal-"));
after(() => rmSync(directory, { recursive: true, force: true }));
let counter = 0;
const path = () => join(directory, `${counter++}.sqlite`);

function record(deadline: number, digest = `0x${deadline.toString(16).padStart(64, "0")}`) {
  return {
    digest,
    epoch: 1,
    expiryMs: deadline * 1000,
    signature: "0xsig",
    createdMs: 1,
    payload: buildFixture().payload,
    grossId: digest,
    grossItem: { market: 0 as const, baseDelta: BASE, reduceOnly: false, deadline, makerDebit: 5n },
  };
}

test("commit persists the approval and reservation and survives restart", () => {
  const file = path(),
    journal = new ApprovalJournal(file, "ctx");
  journal.commit(record(100));
  assert.equal(journal.signatureFor(record(100).digest), "0xsig");
  assert.equal(journal.gross.size, 1);
  assert.equal(journal.gross.capitalDebit(), 5n);
  journal.close();
  const restarted = new ApprovalJournal(file, "ctx");
  assert.equal(restarted.gross.size, 1);
  const exported = restarted.recoveryExport("0xsigner");
  assert.equal(exported.signer, "0xsigner");
  assert.equal(exported.approvals.length, 1);
  assert.equal(exported.grossReservations.length, 1);
  restarted.close();
  assert.throws(() => new ApprovalJournal(file, "other"), /signing context mismatch/);
});

test("a failed commit rolls back and leaves memory unreserved", () => {
  const journal = new ApprovalJournal(path(), "ctx");
  journal.commit(record(100));
  assert.throws(() => journal.commit(record(100)), /UNIQUE|constraint/i);
  assert.equal(journal.gross.size, 1);
  journal.close();
});

test("finalize releases expired reservations and archives expired approvals", () => {
  const file = path(),
    journal = new ApprovalJournal(file, "ctx");
  journal.commit(record(100));
  journal.commit(record(300));
  journal.finalize(10, 200);
  assert.equal(journal.gross.size, 1);
  assert.equal(journal.recoveryExport("0x").approvals.length, 1);
  journal.close();
  const database = new DatabaseSync(file);
  assert.equal(
    (database.prepare("SELECT count(*) count FROM archived_approvals").get() as { count: number }).count,
    1,
  );
  database.close();
});

test("legacy approvals without payloads block signing until finalized past their expiry", () => {
  const file = path(),
    seed = new ApprovalJournal(file, "ctx");
  seed.close();
  const database = new DatabaseSync(file);
  database
    .prepare("INSERT INTO approvals (digest,epoch,expiry_ms,signature,created_ms) VALUES (?,?,?,?,?)")
    .run("0xlegacy", 1, 150_000, "0xsig", 1);
  database.close();
  const journal = new ApprovalJournal(file, "ctx");
  assert.equal(journal.incompleteLegacy, true);
  assert.equal(journal.recoveryExport("0x").incomplete?.count, 1);
  journal.finalize(1, 151);
  assert.equal(journal.incompleteLegacy, false);
  journal.close();
});
