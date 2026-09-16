import {z} from 'zod';
import {candidatePaths,candidateHash as hashCandidate,readCandidateArtifact} from './candidate-identity.js';
const hash=z.string().regex(/^[a-f0-9]{64}$/),artifact=z.object({path:z.string(),sha256:hash}).strict();
const schema=z.object({version:z.literal(1),chainId:z.literal('8453'),candidate:z.array(artifact).min(1),work:z.array(z.object({id:z.string().regex(/^R(?:[1-9]|1[0-6])$/),status:z.literal('verified'),evidence:artifact}).strict()).length(16),soak:artifact,audits:z.array(z.object({reviewer:z.string().min(1),scope:z.enum(['contracts','services','operations']),candidateHash:hash,report:artifact}).strict()).min(3)}).strict();
export function checkReleaseEvidence(input:unknown,root=process.cwd()){
 const data=schema.parse(input),read=(entry:z.infer<typeof artifact>)=>readCandidateArtifact(entry,root);
 const ids=new Set(data.work.map(row=>row.id));if(ids.size!==16)throw new Error('All sixteen distinct work items must have verified evidence');
 const expected=candidatePaths(root);
 const listed=new Set(data.candidate.map(entry=>entry.path));if(expected.some(path=>!listed.has(path)))throw new Error('Candidate manifest omits repository runtime/build source');
 const sourceEntries=data.candidate.map(entry=>{if(!expected.includes(entry.path)||/(^|\/)\.\.|\.env|secret|identities\.json/i.test(entry.path))throw new Error('Invalid candidate source path');read(entry);return `${entry.path}\0${entry.sha256}`;}).sort();
 if(new Set(sourceEntries.map(item=>item.split('\0')[0])).size!==sourceEntries.length)throw new Error('Duplicate candidate file');
 const candidateHash=hashCandidate(data.candidate);
 for(const row of data.work)read(row.evidence);
 if(new Set(data.audits.map(row=>row.scope)).size!==3)throw new Error('Independent contracts, services and operations reviews required');
 for(const audit of data.audits){if(audit.candidateHash!==candidateHash)throw new Error('Audit refers to another candidate');read(audit.report);}
 const soak=JSON.parse(read(data.soak).toString());
 if(soak.version!==3||soak.status!=='completed'||soak.failures!==0||soak.requestedHours<72||soak.elapsedMs<72*3_600_000||soak.completed<1)throw new Error('Complete successful 72-hour soak evidence required');
 if(soak.candidateHash!==candidateHash||soak.finalCandidateHash!==candidateHash||!hash.safeParse(soak.deploymentHash).success||soak.finalDeploymentHash!==soak.deploymentHash)throw new Error('Soak must qualify the unchanged reviewed source and deployment');
 const evidence=soak.results?.filter((item:{evidence?:{verified?:boolean}})=>item.evidence?.verified===true)??[];
 if(evidence.length!==soak.completed*2||!evidence.some((item:{evidence:{market:string}})=>item.evidence.market==='BTC')||!evidence.some((item:{evidence:{market:string}})=>item.evidence.market==='ETH'))throw new Error('Soak lacks both-market transaction evidence for every cycle');
 return {readyForDeploymentReview:true,candidateHash,chainId:data.chainId};
}
