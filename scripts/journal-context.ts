import {readFileSync} from "node:fs";
import {z} from "zod";

const address=z.string().regex(/^0x[0-9a-fA-F]{40}$/).transform(value=>value.toLowerCase());

export const journalContextSchema=z.object({
  version:z.literal(1),
  environment:z.enum(["base-sepolia","base-mainnet"]),
  chainId:z.string().regex(/^\d+$/),
  clearingAddress:address,
  role:z.enum(["api","approver","indexer","hedger","keeper"]),
  writerAddress:address.optional(),
  candidateHash:z.string().regex(/^[0-9a-f]{64}$/),
}).strict().superRefine((value,context)=>{
  const expected=value.environment==="base-mainnet"?"8453":"84532";
  if(value.chainId!==expected)context.addIssue({code:"custom",path:["chainId"],message:"chain does not match environment"});
  if(["api","approver","hedger","keeper"].includes(value.role)&&!value.writerAddress)context.addIssue({code:"custom",path:["writerAddress"],message:"signing roles require a writer address"});
  if(value.role==="indexer"&&value.writerAddress)context.addIssue({code:"custom",path:["writerAddress"],message:"indexer must not bind a signing address"});
});

export type JournalContext=z.infer<typeof journalContextSchema>;

export const journalSnapshotManifestSchema=z.object({
  version:z.literal(2),createdAt:z.string().datetime(),sha256:z.string().regex(/^[0-9a-f]{64}$/),sizeBytes:z.number().int().positive(),context:journalContextSchema,
}).strict();

export type JournalSnapshotManifest=z.infer<typeof journalSnapshotManifestSchema>;

export function readJournalContext(path:string){
  return journalContextSchema.parse(JSON.parse(readFileSync(path,"utf8")));
}
