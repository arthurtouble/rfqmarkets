import assert from "node:assert/strict";
import test from "node:test";
import {CHUNK_CHARS,loadJournals,saveJournals} from "./dev-journal-store.mjs";

const memory=()=>{const map=new Map();return {map,get:async key=>map.get(key),put:async(key,value)=>{map.set(key,value);},delete:async key=>map.delete(key)};};
const proxy="0x00000000000000000000000000000000000000Aa";

test("journals round-trip in chunks and older generations are removed",async()=>{
  const storage=memory(),large="x".repeat(CHUNK_CHARS*2+5);
  assert.equal(await loadJournals(storage,proxy),null);
  await saveJournals(storage,proxy,{"api.sqlite":large,"indexer.sqlite":"abc"});
  assert.deepEqual(await loadJournals(storage,proxy.toLowerCase()),{"api.sqlite":large,"indexer.sqlite":"abc"});
  const keys=storage.map.size;
  await saveJournals(storage,proxy,{"api.sqlite":"new","indexer.sqlite":"abc"});
  assert.deepEqual(await loadJournals(storage,proxy),{"api.sqlite":"new","indexer.sqlite":"abc"});
  assert.equal(storage.map.size,3,`previous ${keys - 1} chunks are deleted`);
});

test("journals are scoped to one proxy and a missing chunk fails loudly",async()=>{
  const storage=memory();await saveJournals(storage,proxy,{"api.sqlite":"abc"},"gen");
  assert.equal(await loadJournals(storage,"0x00000000000000000000000000000000000000bb"),null);
  storage.map.delete(`journal:${proxy.toLowerCase()}:gen:api.sqlite:0`);
  await assert.rejects(loadJournals(storage,proxy),/missing chunk 0/);
});
