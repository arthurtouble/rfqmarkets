import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,mkdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {checkReleaseEvidence} from './release-evidence.js';
test('release review requires complete source, exact audit identity and sustained successful evidence',()=>{
 const root=mkdtempSync(join(tmpdir(),'rfq-release-'));try{
 mkdirSync(join(root,'contracts'));const put=(path:string,text:string)=>{writeFileSync(join(root,path),text);return {path,sha256:createHash('sha256').update(text).digest('hex')};};
 const candidate=[put('contracts/Clearing.sol','candidate')],candidateHash=createHash('sha256').update(`contracts/Clearing.sol\0${candidate[0].sha256}`).digest('hex'),proof=put('review.md','external evidence');
 const results=Array.from({length:2},(_,i)=>({evidence:{verified:true,market:i?'ETH':'BTC'}}));const soak=put('soak.json',JSON.stringify({version:3,candidateHash,finalCandidateHash:candidateHash,deploymentHash:'1'.repeat(64),finalDeploymentHash:'1'.repeat(64),status:'completed',failures:0,requestedHours:72,elapsedMs:72*3600000,completed:1,results}));
 const input={version:1,chainId:'8453',candidate,work:Array.from({length:16},(_,i)=>({id:`R${i+1}`,status:'verified',evidence:proof})),soak,audits:['contracts','services','operations'].map(scope=>({reviewer:'independent',scope,candidateHash,report:proof}))};
 assert.equal(checkReleaseEvidence(input,root).readyForDeploymentReview,true);
 assert.throws(()=>checkReleaseEvidence({...input,work:input.work.slice(1)},root));
 put('contracts/Omitted.sol','not reviewed');assert.throws(()=>checkReleaseEvidence(input,root),/omits/);rmSync(join(root,'contracts/Omitted.sol'));
 assert.throws(()=>checkReleaseEvidence({...input,audits:input.audits.map(a=>({...a,candidateHash:'0'.repeat(64)}))},root),/another candidate/);
 const short=put('short.json',JSON.stringify({version:3,candidateHash,finalCandidateHash:candidateHash,deploymentHash:'1'.repeat(64),finalDeploymentHash:'1'.repeat(64),status:'completed',failures:0,requestedHours:72,elapsedMs:3600000,completed:1,results}));assert.throws(()=>checkReleaseEvidence({...input,soak:short},root),/72-hour/);
 const mismatched=put('mismatched.json',JSON.stringify({version:3,status:'completed',failures:0,requestedHours:72,elapsedMs:72*3600000,completed:1,results,candidateHash:'0'.repeat(64)}));assert.throws(()=>checkReleaseEvidence({...input,soak:mismatched},root),/unchanged reviewed/);
 put('Dockerfile.host','unreviewed image');assert.throws(()=>checkReleaseEvidence(input,root),/omits/);rmSync(join(root,'Dockerfile.host'));
 put('contracts/Clearing.sol','changed');assert.throws(()=>checkReleaseEvidence(input,root),/checksum/);
 }finally{rmSync(root,{recursive:true,force:true});}
});
