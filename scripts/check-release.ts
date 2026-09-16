import {readFileSync} from 'node:fs';
import {checkReleaseEvidence} from './release-evidence.js';
if(!process.argv[2])throw new Error('Supply an immutable release evidence manifest; missing evidence never enables mainnet');
console.log(JSON.stringify(checkReleaseEvidence(JSON.parse(readFileSync(process.argv[2],'utf8'))),null,2));
