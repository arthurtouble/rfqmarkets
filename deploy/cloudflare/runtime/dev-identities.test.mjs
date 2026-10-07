import assert from "node:assert/strict";
import test from "node:test";
import { Wallet } from "ethers";
import { ensureIdentities, matchesDeployment, publicIdentities } from "./dev-identities.mjs";

const memory=()=>{const map=new Map();return {get:async key=>map.get(key),put:async(key,value)=>{map.set(key,value);}};};

test("runtime keys are created once, kept, and only addresses are published",async()=>{
  const storage=memory(),first=await ensureIdentities(storage),again=await ensureIdentities(storage);
  assert.deepEqual(again,first);
  for(const item of [first.emergency,first.sponsor,...first.approvers])assert.equal(new Wallet(item.privateKey).address,item.address);
  const published=JSON.stringify(publicIdentities(first));
  assert.equal(published.includes(first.sponsor.privateKey.slice(2)),false);
  assert.equal(new Set([first.emergency,first.sponsor,...first.approvers].map(item=>item.address)).size,5);
});

test("the runtime refuses a deployment whose approvers are not its keys",async()=>{
  const identities=await ensureIdentities(memory()),approvers=identities.approvers.map(item=>item.address);
  assert.equal(matchesDeployment(identities,{approvers:[...approvers].reverse().map(item=>item.toLowerCase())}),true);
  assert.equal(matchesDeployment(identities,{approvers:[approvers[0],approvers[1],Wallet.createRandom().address]}),false);
  assert.equal(matchesDeployment(identities,{}),false);
});
