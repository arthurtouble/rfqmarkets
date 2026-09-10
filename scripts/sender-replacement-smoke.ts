import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { JsonRpcProvider, Wallet, parseEther } from "ethers";
import { DurableSender } from "../services/api/src/sender.js";

const provider=new JsonRpcProvider(process.env.RFQ_RPC_URL??"http://127.0.0.1:8545"),funder=await provider.getSigner(0),wallet=new Wallet(Wallet.createRandom().privateKey,provider),directory=mkdtempSync(join(tmpdir(),"rfq-sender-")),database=new DatabaseSync(join(directory,"sender.sqlite"));
await (await funder.sendTransaction({to:wallet.address,value:parseEther("0.1")})).wait();const sender=new DurableSender(provider,wallet,database,{firstWaitMs:150,replacementWaitMs:3_000,pollMs:25,maxReplacements:1,bumpBps:1_500});
await provider.send("evm_setAutomine",[false]);
try{
  const mining=setTimeout(()=>void provider.send("evm_mine",[]),1_500),receipt=await sender.submit("forced-replacement",{to:wallet.address,value:1n,gasLimit:21_000n});clearTimeout(mining);
  const attempts=database.prepare("SELECT attempt,tx_hash FROM sender_attempts WHERE operation_id=? ORDER BY attempt").all("forced-replacement") as Array<{attempt:number;tx_hash:string}>;
  assert.equal(attempts.length,2,"sender did not journal a fee-bumped attempt");assert.equal(receipt.hash,attempts[1].tx_hash,"replacement was not the included attempt");
  console.log(`Sender replacement smoke passed: nonce-preserving attempt ${attempts[0].tx_hash} was replaced by ${attempts[1].tx_hash}`);
}finally{await provider.send("evm_setAutomine",[true]);await provider.send("evm_mine",[]);database.close();rmSync(directory,{recursive:true,force:true});}
