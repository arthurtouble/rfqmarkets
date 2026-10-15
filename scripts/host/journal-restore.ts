import { DatabaseSync } from "node:sqlite";
import { chmodSync, copyFileSync, existsSync, readFileSync, renameSync, unlinkSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";

// Run only after fencing the old writer and while holding the destination role's writer.lock.
const snapshot = resolve(process.argv[2]),
  destination = resolve(process.argv[3]);
if (existsSync(destination)) throw new Error("Restore destination already exists");
const manifest = JSON.parse(readFileSync(join(snapshot, "manifest.json"), "utf8")) as {
  version?: unknown;
  sha256?: unknown;
};
if (manifest.version !== 1 || typeof manifest.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(manifest.sha256))
  throw new Error("Invalid snapshot manifest");
const source = join(snapshot, "journal.sqlite"),
  digest = createHash("sha256").update(readFileSync(source)).digest("hex");
if (digest !== manifest.sha256) throw new Error("Snapshot checksum mismatch");
const database = new DatabaseSync(source, { readOnly: true });
try {
  if (database.prepare("PRAGMA integrity_check").get()?.integrity_check !== "ok")
    throw new Error("Snapshot integrity check failed");
} finally {
  database.close();
}
const temporary = `${destination}.partial`;
if (existsSync(temporary)) throw new Error("Restore temporary destination already exists");
try {
  copyFileSync(source, temporary);
  chmodSync(temporary, 0o600);
  const restored = new DatabaseSync(temporary);
  try {
    if (restored.prepare("PRAGMA integrity_check").get()?.integrity_check !== "ok")
      throw new Error("Restored journal integrity check failed");
  } finally {
    restored.close();
  }
  renameSync(temporary, destination);
} catch (error) {
  if (existsSync(temporary)) unlinkSync(temporary);
  throw error;
}
