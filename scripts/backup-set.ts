import {createHash} from "node:crypto";
import {readFileSync,writeFileSync} from "node:fs";
import {resolve} from "node:path";
import {journalSnapshotManifestSchema,type JournalSnapshotManifest} from "./journal-context.js";

const requiredCounts={api:1,approver:3,indexer:1,hedger:1,keeper:1} as const;

export function validateBackupSet(paths:string[]){
  const manifests=paths.map(path=>journalSnapshotManifestSchema.parse(JSON.parse(readFileSync(path,"utf8"))));
  if(manifests.length!==7)throw new Error("A recovery set requires exactly seven role manifests");
  const reference=manifests[0]!.context;
  for(const manifest of manifests){
    const context=manifest.context;
    if(context.environment!==reference.environment||context.chainId!==reference.chainId||context.clearingAddress!==reference.clearingAddress||context.candidateHash!==reference.candidateHash)throw new Error("Backup manifests do not describe one deployment candidate");
  }
  for(const [role,count] of Object.entries(requiredCounts)){
    if(manifests.filter(value=>value.context.role===role).length!==count)throw new Error(`Recovery set requires ${count} ${role} manifest(s)`);
  }
  const writerAddresses=manifests.flatMap(value=>value.context.writerAddress?[value.context.writerAddress]:[]);
  if(new Set(writerAddresses).size!==writerAddresses.length)throw new Error("Signing role backup manifests require distinct writer addresses");
  const times=manifests.map(value=>Date.parse(value.createdAt));
  if(times.some(value=>!Number.isFinite(value)))throw new Error("Backup set contains an invalid creation time");
  return {manifests,oldestAtMs:Math.min(...times),newestAtMs:Math.max(...times),context:{environment:reference.environment,chainId:reference.chainId,clearingAddress:reference.clearingAddress,candidateHash:reference.candidateHash}};
}

export function backupSetEvidence(paths:string[]){
  const value=validateBackupSet(paths),members=value.manifests.map((manifest:JournalSnapshotManifest)=>({role:manifest.context.role,writerAddress:manifest.context.writerAddress,createdAt:manifest.createdAt,sha256:manifest.sha256,sizeBytes:manifest.sizeBytes})).sort((left,right)=>`${left.role}:${left.writerAddress??""}`.localeCompare(`${right.role}:${right.writerAddress??""}`));
  const setSha256=createHash("sha256").update(JSON.stringify({context:value.context,members})).digest("hex");
  return {version:1,createdAt:new Date().toISOString(),...value.context,oldestAt:new Date(value.oldestAtMs).toISOString(),newestAt:new Date(value.newestAtMs).toISOString(),setSha256,members};
}

if(process.argv[1]&&resolve(process.argv[1])===resolve(new URL(import.meta.url).pathname)){
  const output=process.argv[2],paths=process.argv.slice(3);if(!output||paths.length===0)throw new Error("Usage: backup-set OUTPUT_JSON MANIFEST_JSON...");
  writeFileSync(output,`${JSON.stringify(backupSetEvidence(paths),null,2)}\n`,{mode:0o600,flag:"wx"});
}
