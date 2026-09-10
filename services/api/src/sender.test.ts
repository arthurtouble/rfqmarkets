import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { Transaction, Wallet, keccak256 } from "ethers";
import { DurableSender } from "./sender.js";

type Receipt={transactionHash:string;blockNumber:string;blockHash:string;status:string};

class DeterministicProvider {
  pendingNonce=0;
  broadcasts:string[]=[];
  receipts=new Map<string,Receipt>();
  failBeforeAccept=false;
  failAfterAccept=false;
  async getFeeData(){return {gasPrice:null,maxFeePerGas:2_000_000_000n,maxPriorityFeePerGas:1_000_000_000n};}
  async send(method:string,params:unknown[]){
    if(method==="eth_getTransactionCount")return `0x${this.pendingNonce.toString(16)}`;
    if(method==="eth_getTransactionReceipt")return this.receipts.get(String(params[0]))??null;
    throw new Error(`unsupported ${method}`);
  }
  async broadcastTransaction(raw:string){
    if(this.failBeforeAccept){this.failBeforeAccept=false;throw new Error("transport failed before acceptance");}
    const transaction=Transaction.from(raw),hash=keccak256(raw);this.broadcasts.push(raw);
    this.pendingNonce=Math.max(this.pendingNonce,transaction.nonce+1);
    this.receipts.set(hash,{transactionHash:hash,blockNumber:`0x${(100+this.pendingNonce).toString(16)}`,blockHash:`0x${hash.slice(2).padEnd(64,"0")}`,status:"0x1"});
    if(this.failAfterAccept){this.failAfterAccept=false;throw new Error("transport failed after acceptance");}
    return {};
  }
}

const options={chainId:31_337n,firstWaitMs:20,replacementWaitMs:20,pollMs:1,maxReplacements:0};
const request={to:"0x0000000000000000000000000000000000000001",data:"0x1234",value:0n,gasLimit:100_000n};
const rows=(database:DatabaseSync)=>database.prepare("SELECT operation_id,nonce,tx_hash,status FROM sender_transactions ORDER BY nonce").all() as Array<{operation_id:string;nonce:number;tx_hash:string;status:string}>;
const randomWallet=()=>new Wallet(Wallet.createRandom().privateKey);

test("parallel operations serialize onto unique consecutive sponsor nonces",async()=>{
  const provider=new DeterministicProvider(),database=new DatabaseSync(":memory:"),wallet=randomWallet();
  const sender=new DurableSender(provider as never,wallet,database,options);
  const receipts=await Promise.all(Array.from({length:100},(_,index)=>sender.submit(`parallel-${index}`,request)));
  assert.equal(new Set(receipts.map(item=>item.hash)).size,100);
  const journal=rows(database);assert.equal(journal.length,100);assert.deepEqual(journal.map(item=>item.nonce),Array.from({length:100},(_,index)=>index));
  assert(journal.every(item=>item.status==="included"));assert.equal(provider.pendingNonce,100);database.close();
});

test("restart rebroadcasts the exact journaled transaction after a pre-accept crash",async()=>{
  const provider=new DeterministicProvider(),database=new DatabaseSync(":memory:"),wallet=randomWallet();provider.failBeforeAccept=true;
  const first=new DurableSender(provider as never,wallet,database,options);
  await assert.rejects(first.submit("before-accept",request),/before acceptance/);
  const signed=rows(database)[0];assert.equal(signed.status,"signed");assert.equal(provider.broadcasts.length,0);
  const restarted=new DurableSender(provider as never,wallet,database,options),receipt=await restarted.submit("before-accept",request);
  assert.equal(receipt.hash,signed.tx_hash);assert.equal(provider.broadcasts.length,1);assert.equal(rows(database)[0].status,"included");database.close();
});

test("restart discovers inclusion after an ambiguous post-accept transport crash",async()=>{
  const provider=new DeterministicProvider(),database=new DatabaseSync(":memory:"),wallet=randomWallet();provider.failAfterAccept=true;
  const first=new DurableSender(provider as never,wallet,database,options);
  await assert.rejects(first.submit("after-accept",request),/after acceptance/);
  const signed=rows(database)[0];assert.equal(signed.status,"signed");assert.equal(provider.broadcasts.length,1);assert(provider.receipts.has(signed.tx_hash));
  const restarted=new DurableSender(provider as never,wallet,database,options),receipt=await restarted.submit("after-accept",request);
  assert.equal(receipt.hash,signed.tx_hash);assert.equal(provider.broadcasts.length,1,"included transaction was needlessly rebroadcast");assert.equal(rows(database)[0].status,"included");database.close();
});

test("reconcile marks an externally consumed nonce ambiguous instead of guessing success",async()=>{
  const provider=new DeterministicProvider(),database=new DatabaseSync(":memory:"),wallet=randomWallet();provider.failBeforeAccept=true;
  const sender=new DurableSender(provider as never,wallet,database,options);await assert.rejects(sender.submit("lost",request));
  provider.pendingNonce=1;await sender.reconcile();assert.equal(rows(database)[0].status,"ambiguous");database.close();
});
