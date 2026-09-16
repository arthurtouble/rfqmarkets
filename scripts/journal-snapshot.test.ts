import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
test('journal snapshot retains escaped commitments and validates restored integrity',()=>{
 const directory=mkdtempSync(join(tmpdir(),'rfq-backup-')),source=join(directory,'source.sqlite'),snapshot=join(directory,'snapshot');
 try{const db=new DatabaseSync(source);db.exec("PRAGMA journal_mode=WAL;CREATE TABLE approvals(digest TEXT PRIMARY KEY,payload TEXT);INSERT INTO approvals VALUES('escaped','signed-payload')");
 execFileSync(process.execPath,['--import','tsx',resolve('scripts/journal-snapshot.ts'),source,snapshot]);db.close();
 const manifest=JSON.parse(readFileSync(join(snapshot,'manifest.json'),'utf8'));assert.equal(manifest.sha256,createHash('sha256').update(readFileSync(join(snapshot,'journal.sqlite'))).digest('hex'));
 const destination=join(directory,'restored.sqlite');execFileSync(process.execPath,['--import','tsx',resolve('scripts/journal-restore.ts'),snapshot,destination]);
 const restored=new DatabaseSync(destination);assert.equal(restored.prepare('SELECT payload FROM approvals').get()!.payload,'signed-payload');assert.equal(restored.prepare('PRAGMA integrity_check').get()!.integrity_check,'ok');restored.close();
 assert.throws(()=>execFileSync(process.execPath,['--import','tsx',resolve('scripts/journal-restore.ts'),snapshot,destination]),/Restore destination already exists/);
 const manifestPath=join(snapshot,'manifest.json'),tamperedManifest=JSON.parse(readFileSync(manifestPath,'utf8'));tamperedManifest.sha256='0'.repeat(64);writeFileSync(manifestPath,JSON.stringify(tamperedManifest));assert.throws(()=>execFileSync(process.execPath,['--import','tsx',resolve('scripts/journal-restore.ts'),snapshot,join(directory,'tampered.sqlite')]),/Snapshot checksum mismatch/);
 }finally{rmSync(directory,{recursive:true,force:true});}
});
