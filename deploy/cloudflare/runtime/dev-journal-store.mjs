// Durable Object storage for the dev container's SQLite journals. Values are chunked below the
// storage value limit and written under a fresh generation, so a reader never sees a half-written set.
export const CHUNK_CHARS=512*1024;
const manifestKey=clearing=>`journals:${clearing.toLowerCase()}`;
const chunkKey=(clearing,generation,file,index)=>`journal:${clearing.toLowerCase()}:${generation}:${file}:${index}`;

export async function saveJournals(storage,clearing,files,generation=crypto.randomUUID()){
  const counts={};
  for(const [file,data] of Object.entries(files)){
    const count=Math.max(1,Math.ceil(data.length/CHUNK_CHARS));counts[file]=count;
    for(let index=0;index<count;index++)await storage.put(chunkKey(clearing,generation,file,index),data.slice(index*CHUNK_CHARS,(index+1)*CHUNK_CHARS));
  }
  const previous=await storage.get(manifestKey(clearing));
  await storage.put(manifestKey(clearing),{generation,counts,savedAt:new Date().toISOString()});
  if(previous)for(const [file,count] of Object.entries(previous.counts))for(let index=0;index<count;index++)await storage.delete(chunkKey(clearing,previous.generation,file,index));
  return {generation,files:Object.keys(counts)};
}

export async function loadJournals(storage,clearing){
  const manifest=await storage.get(manifestKey(clearing));if(!manifest)return null;
  const files={};
  for(const [file,count] of Object.entries(manifest.counts)){
    const parts=[];for(let index=0;index<count;index++){const part=await storage.get(chunkKey(clearing,manifest.generation,file,index));if(typeof part!=="string")throw new Error(`journal ${file} is missing chunk ${index}`);parts.push(part);}
    files[file]=parts.join("");
  }
  return files;
}
