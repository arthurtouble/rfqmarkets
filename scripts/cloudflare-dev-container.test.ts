import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { restoreJournals, snapshotJournals } from "./cloudflare-dev-container.js";

test("journals survive a snapshot and restore into a fresh container",()=>{
  const source=mkdtempSync(join(tmpdir(),"rfq-journal-")),target=mkdtempSync(join(tmpdir(),"rfq-journal-"));
  try{
    const live=new DatabaseSync(join(source,"api.sqlite"));live.exec("PRAGMA journal_mode=WAL;CREATE TABLE commitments(id TEXT PRIMARY KEY);INSERT INTO commitments VALUES ('a'),('b');");
    const files=snapshotJournals(source);live.exec("INSERT INTO commitments VALUES ('c')");live.close();
    assert.deepEqual(Object.keys(files),["api.sqlite"]);
    restoreJournals(target,files);
    const restored=new DatabaseSync(join(target,"api.sqlite"),{readOnly:true});
    assert.deepEqual(restored.prepare("SELECT id FROM commitments ORDER BY id").all().map(row=>row.id),["a","b"]);restored.close();
    assert.throws(()=>restoreJournals(target,files),/refusing to overwrite/);
    assert.throws(()=>restoreJournals(join(target,"other"),{"../escape.sqlite":files["api.sqlite"]}),/unexpected journal name/);
    assert.throws(()=>restoreJournals(join(target,"corrupt"),{"api.sqlite":Buffer.from("not a database").toString("base64")}));
    assert.ok(!readdirSync(source).some(name=>name.includes("snapshot")),"snapshot copies are cleaned up");
  }finally{rmSync(source,{recursive:true,force:true});rmSync(target,{recursive:true,force:true});}
});
