import assert from "node:assert/strict";
import {test} from "node:test";
import {mkdtempSync,rmSync,writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {backupSetEvidence,validateBackupSet} from "./backup-set.js";

const roles=["api","approver","approver","approver","indexer","hedger","keeper"] as const;

function fixture(directory:string,mutate?:(manifest:any,index:number)=>void){
  return roles.map((role,index)=>{
    const manifest={version:2,createdAt:new Date(10_000+index*1_000).toISOString(),sha256:String(index).repeat(64),sizeBytes:100+index,context:{version:1,environment:"base-sepolia",chainId:"84532",clearingAddress:"0x0000000000000000000000000000000000000001",role,writerAddress:role==="indexer"?undefined:`0x${String(index+2).padStart(40,"0")}`,candidateHash:"a".repeat(64)}};
    mutate?.(manifest,index);const path=join(directory,`${index}.json`);writeFileSync(path,JSON.stringify(manifest));return path;
  });
}

test("backup evidence requires one coherent and complete recovery set",()=>{
  const directory=mkdtempSync(join(tmpdir(),"rfq-backup-set-"));
  try{
    const paths=fixture(directory),validated=validateBackupSet(paths),evidence=backupSetEvidence(paths);
    assert.equal(validated.manifests.length,7);assert.equal(validated.oldestAtMs,10_000);assert.equal(evidence.members.length,7);assert.match(evidence.setSha256,/^[0-9a-f]{64}$/);
    assert.throws(()=>validateBackupSet(paths.slice(1)),/exactly seven/);
  }finally{rmSync(directory,{recursive:true,force:true});}
});

test("backup evidence rejects mixed candidates and duplicate signing identities",()=>{
  const first=mkdtempSync(join(tmpdir(),"rfq-backup-mixed-")),second=mkdtempSync(join(tmpdir(),"rfq-backup-duplicate-"));
  try{
    assert.throws(()=>validateBackupSet(fixture(first,(manifest,index)=>{if(index===6)manifest.context.candidateHash="b".repeat(64);})),/one deployment candidate/);
    assert.throws(()=>validateBackupSet(fixture(second,(manifest,index)=>{if(index===6)manifest.context.writerAddress=`0x${String(2).padStart(40,"0")}`;})),/distinct writer addresses/);
  }finally{rmSync(first,{recursive:true,force:true});rmSync(second,{recursive:true,force:true});}
});
