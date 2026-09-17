import {DatabaseSync} from "node:sqlite";
import {mkdirSync,readFileSync,writeFileSync,renameSync,existsSync,statSync} from "node:fs";
import {resolve,join} from "node:path";
import {createHash} from "node:crypto";
import {readJournalContext} from "./journal-context.js";

// Run only under the same exclusive writer.lock as the stopped role service.
const source=resolve(process.argv[2]??""),destination=resolve(process.argv[3]??""),contextPath=process.argv[4];
if(!process.argv[2]||!process.argv[3]||!contextPath)throw new Error("Usage: journal-snapshot SOURCE_DB SNAPSHOT_DIRECTORY CONTEXT_JSON");
if(existsSync(destination))throw new Error("Snapshot destination already exists");
const context=readJournalContext(contextPath),started=performance.now(),temporary=`${destination}.partial`;
mkdirSync(temporary,{mode:0o700});
const database=new DatabaseSync(source,{readOnly:true});
try{
  if(database.prepare("PRAGMA integrity_check").get()?.integrity_check!=="ok")throw new Error("Journal integrity check failed");
  const output=join(temporary,"journal.sqlite");
  database.exec(`VACUUM INTO '${output.replaceAll("'","''")}'`);
  const contents=readFileSync(output),manifest={
    version:2,
    createdAt:new Date().toISOString(),
    sha256:createHash("sha256").update(contents).digest("hex"),
    sizeBytes:statSync(output).size,
    context,
  };
  writeFileSync(join(temporary,"manifest.json"),`${JSON.stringify(manifest,null,2)}\n`,{mode:0o600});
  renameSync(temporary,destination);
  console.log(JSON.stringify({snapshot:destination,role:context.role,sizeBytes:manifest.sizeBytes,elapsedMs:Math.round(performance.now()-started)}));
}finally{database.close();}
