import {DatabaseSync} from "node:sqlite";
import {chmodSync,copyFileSync,existsSync,readFileSync,renameSync,statSync,unlinkSync} from "node:fs";
import {createHash} from "node:crypto";
import {join,resolve} from "node:path";
import {journalSnapshotManifestSchema,readJournalContext} from "./journal-context.js";

// Run only after fencing the old writer and while holding the destination role's writer.lock.
const snapshot=resolve(process.argv[2]??""),destination=resolve(process.argv[3]??""),contextPath=process.argv[4];
if(!process.argv[2]||!process.argv[3]||!contextPath)throw new Error("Usage: journal-restore SNAPSHOT_DIRECTORY DESTINATION_DB EXPECTED_CONTEXT_JSON");
if(existsSync(destination))throw new Error("Restore destination already exists");
const expected=readJournalContext(contextPath),manifest=journalSnapshotManifestSchema.parse(JSON.parse(readFileSync(join(snapshot,"manifest.json"),"utf8")));
if(JSON.stringify(manifest.context)!==JSON.stringify(expected))throw new Error("Snapshot context does not match destination role");
const source=join(snapshot,"journal.sqlite"),contents=readFileSync(source),digest=createHash("sha256").update(contents).digest("hex");
if(digest!==manifest.sha256||statSync(source).size!==manifest.sizeBytes)throw new Error("Snapshot checksum or size mismatch");
const database=new DatabaseSync(source,{readOnly:true});
try{if(database.prepare("PRAGMA integrity_check").get()?.integrity_check!=="ok")throw new Error("Snapshot integrity check failed");}finally{database.close();}
const started=performance.now(),temporary=`${destination}.partial`;
if(existsSync(temporary))throw new Error("Restore temporary destination already exists");
try{
  copyFileSync(source,temporary);chmodSync(temporary,0o600);
  const restored=new DatabaseSync(temporary);
  try{if(restored.prepare("PRAGMA integrity_check").get()?.integrity_check!=="ok")throw new Error("Restored journal integrity check failed");}finally{restored.close();}
  renameSync(temporary,destination);
  console.log(JSON.stringify({restored:destination,role:expected.role,sizeBytes:manifest.sizeBytes,elapsedMs:Math.round(performance.now()-started)}));
}catch(error){if(existsSync(temporary))unlinkSync(temporary);throw error;}
