import assert from "node:assert/strict";
import {test} from "node:test";
import {AbiCoder,Wallet,id} from "ethers";
import {validOwnerSignature} from "./owner-signature.js";

test("owner authority accepts ERC-1271 bytes signatures and fails closed",async()=>{
  const account=Wallet.createRandom().address,digest=id("owner action"),provider={getCode:async()=>"0x1234",call:async()=>AbiCoder.defaultAbiCoder().encode(["bytes4"],["0x1626ba7e"])};
  assert.equal(await validOwnerSignature(account,digest,"0xab",provider),true);
  assert.equal(await validOwnerSignature(account,digest,"0xab",{...provider,call:async()=>{throw new Error("RPC unavailable");}}),false);
  assert.equal(await validOwnerSignature(account,digest,"0xab",{...provider,getCode:async()=>"0x"}),false);
});
test("EOA action signatures cannot be redirected to another account",async()=>{
  const owner=Wallet.createRandom(),digest=id("withdraw"),signature=owner.signingKey.sign(digest).serialized;
  assert.equal(await validOwnerSignature(owner.address,digest,signature),true);
  assert.equal(await validOwnerSignature(Wallet.createRandom().address,digest,signature),false);
});
