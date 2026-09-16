import {DatabaseSync} from 'node:sqlite';
import {mkdirSync,readFileSync,writeFileSync,renameSync,existsSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {createHash} from 'node:crypto';
// Run only under the same exclusive writer.lock as the stopped role service.
const source=resolve(process.argv[2]),destination=resolve(process.argv[3]);
if(existsSync(destination))throw new Error('Snapshot destination already exists');
const temporary=`${destination}.partial`;mkdirSync(temporary,{mode:0o700});
const database=new DatabaseSync(source,{readOnly:true});
try{
 if(database.prepare('PRAGMA integrity_check').get()?.integrity_check!=='ok')throw new Error('Journal integrity check failed');
 const output=join(temporary,'journal.sqlite');database.exec(`VACUUM INTO '${output.replaceAll("'","''")}'`);
 writeFileSync(join(temporary,'manifest.json'),JSON.stringify({version:1,createdAt:new Date().toISOString(),sha256:createHash('sha256').update(readFileSync(output)).digest('hex')}),{mode:0o600});
 renameSync(temporary,destination);
}finally{database.close();}
