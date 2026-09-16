import {DatabaseSync} from 'node:sqlite';
import {readFileSync,statSync} from 'node:fs';
import {importApproverRecovery} from './approver-recovery.js';
const [journal,source,chain,proxy,signer]=process.argv.slice(2);
if(!journal||!source||!chain||!proxy||!signer)throw new Error('Usage: import-approver-recovery JOURNAL PRIVATE_EXPORT CHAIN_ID PROXY SIGNER; fence writer and hold writer.lock first');
if(!statSync(journal).isFile()||!statSync(source).isFile()||statSync(source).mode&0o077)throw new Error('Recovery requires an existing journal and private 0600 export');
const database=new DatabaseSync(journal);try{console.log(JSON.stringify(importApproverRecovery(database,JSON.parse(readFileSync(source,'utf8')),{chainId:BigInt(chain),proxy,signer}),null,2));}finally{database.close();}
