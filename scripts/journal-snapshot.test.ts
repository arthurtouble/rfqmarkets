import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
test('journal snapshot retains escaped commitments and validates restored integrity',()=>{
 const directory=mkdtempSync(join(tmpdir(),'rfq-backup-')),source=join(directory,'source.sqlite'),snapshot=join(directory,'snapshot'),contextPath=join(directory,'context.json'),otherContextPath=join(directory,'other-context.json');
 try{const db=new DatabaseSync(source);db.exec("PRAGMA journal_mode=WAL;CREATE TABLE approvals(digest TEXT PRIMARY KEY,payload TEXT);INSERT INTO approvals VALUES('escaped','signed-payload')");
 const context={version:1,environment:'base-sepolia',chainId:'84532',clearingAddress:'0x0000000000000000000000000000000000000001',role:'approver',writerAddress:'0x0000000000000000000000000000000000000002',candidateHash:'a'.repeat(64)};writeFileSync(contextPath,JSON.stringify(context));writeFileSync(otherContextPath,JSON.stringify({...context,writerAddress:'0x0000000000000000000000000000000000000003'}));
 execFileSync(process.execPath,['--import','tsx',resolve('scripts/journal-snapshot.ts'),source,snapshot,contextPath]);db.close();
 const manifest=JSON.parse(readFileSync(join(snapshot,'manifest.json'),'utf8'));assert.equal(manifest.version,2);assert.deepEqual(manifest.context,context);assert.equal(manifest.sha256,createHash('sha256').update(readFileSync(join(snapshot,'journal.sqlite'))).digest('hex'));
 assert.throws(()=>execFileSync(process.execPath,['--import','tsx',resolve('scripts/journal-restore.ts'),snapshot,join(directory,'wrong-role.sqlite'),otherContextPath]),/Snapshot context does not match destination role/);
 const destination=join(directory,'restored.sqlite');execFileSync(process.execPath,['--import','tsx',resolve('scripts/journal-restore.ts'),snapshot,destination,contextPath]);
 const restored=new DatabaseSync(destination);assert.equal(restored.prepare('SELECT payload FROM approvals').get()!.payload,'signed-payload');assert.equal(restored.prepare('PRAGMA integrity_check').get()!.integrity_check,'ok');restored.close();
 assert.throws(()=>execFileSync(process.execPath,['--import','tsx',resolve('scripts/journal-restore.ts'),snapshot,destination,contextPath]),/Restore destination already exists/);
 const manifestPath=join(snapshot,'manifest.json'),tamperedManifest=JSON.parse(readFileSync(manifestPath,'utf8'));tamperedManifest.sha256='0'.repeat(64);writeFileSync(manifestPath,JSON.stringify(tamperedManifest));assert.throws(()=>execFileSync(process.execPath,['--import','tsx',resolve('scripts/journal-restore.ts'),snapshot,join(directory,'tampered.sqlite'),contextPath]),/Snapshot checksum or size mismatch/);
 }finally{rmSync(directory,{recursive:true,force:true});}
});
