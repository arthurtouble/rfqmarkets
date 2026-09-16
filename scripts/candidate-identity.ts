import {createHash} from 'node:crypto';
import {readFileSync,readdirSync,existsSync,realpathSync} from 'node:fs';
import {resolve,relative} from 'node:path';
export interface CandidateArtifact {path:string;sha256:string}
const roots=['.github','contracts','services','packages','scripts','apps','deploy','security','simulator'];
const rootFiles=['package.json','package-lock.json','hardhat.config.js','tsconfig.json','Dockerfile.host','Dockerfile.cloudflare','.dockerignore','.npmrc'];
export function candidatePaths(root=process.cwd()){
 const paths:string[]=[];
 const walk=(directory:string)=>{if(!existsSync(resolve(root,directory)))return;for(const item of readdirSync(resolve(root,directory),{withFileTypes:true})){if(['node_modules','dist','.git','.local-state','__pycache__'].includes(item.name))continue;const path=`${directory}/${item.name}`;if(item.isSymbolicLink())throw new Error('Candidate source cannot contain symlinks');if(item.isDirectory())walk(path);else if(/\.(sol|ts|tsx|js|mjs|py|json|jsonc|html|css|txt|lock|toml|yaml|yml|sh|service)$/.test(item.name))paths.push(path);}};
 for(const directory of roots)walk(directory);for(const path of rootFiles)if(existsSync(resolve(root,path)))paths.push(path);return paths.sort();
}
export function readCandidateArtifact(entry:CandidateArtifact,root=process.cwd()){
 const path=realpathSync(resolve(root,entry.path)),rel=relative(realpathSync(root),path);if(rel.startsWith('..')||rel==='')throw new Error('Artifact must stay inside candidate workspace');
 const bytes=readFileSync(path);if(createHash('sha256').update(bytes).digest('hex')!==entry.sha256)throw new Error(`Artifact checksum mismatch: ${entry.path}`);return bytes;
}
export function candidateHash(entries:CandidateArtifact[]){return createHash('sha256').update(entries.map(entry=>`${entry.path}\0${entry.sha256}`).sort().join('\n')).digest('hex');}
export function identifyCandidate(root=process.cwd()){
 const candidate=candidatePaths(root).map(path=>({path,sha256:createHash('sha256').update(readFileSync(resolve(root,path))).digest('hex')}));return {candidate,candidateHash:candidateHash(candidate)};
}
