import assert from 'node:assert/strict';
import {test} from 'node:test';
import {DatabaseSync} from 'node:sqlite';
import {Wallet,keccak256,toUtf8Bytes} from 'ethers';
import {archiveApiCommitments,initializeApiRecoveryJournal,restoreApiCommitments} from './recovery.js';
import {initializeGrossJournal,persistGross} from '../../../packages/shared/src/gross-reservation-journal.js';
import {approvalToWire,DOMAIN_NAME,DOMAIN_VERSION,hashApproval,hashIntent,intentToWire,intentTypes,type MakerApproval,type SigningDomain,type TradeIntent} from '../../../packages/shared/src/eip712.js';

test('complete API recovery envelopes restore exactly and finalized archival is all-or-none',async()=>{
 const database=new DatabaseSync(':memory:');database.exec("CREATE TABLE commitments(quote_id TEXT PRIMARY KEY,market TEXT NOT NULL,delta TEXT NOT NULL,expires_ms INTEGER NOT NULL,status TEXT NOT NULL,intent_json TEXT NOT NULL,user_signature TEXT NOT NULL,approval_json TEXT,tx_hash TEXT,updated_ms INTEGER NOT NULL)");initializeGrossJournal(database);initializeApiRecoveryJournal(database);
 const wallet=Wallet.createRandom(),domain:SigningDomain={name:DOMAIN_NAME,version:DOMAIN_VERSION,chainId:84532n,verifyingContract:'0x0000000000000000000000000000000000000001'},deadline=Math.floor(Date.now()/1000)+60,quoteId=crypto.randomUUID();
 const intent:TradeIntent={account:wallet.address,market:0,baseDelta:1_000_000_000_000_000n,limitPrice:100_200_000_000n,maxFee:50_000n,nonce:7n,deadline:BigInt(deadline),reduceOnly:false},userSignature=await wallet.signTypedData(domain,intentTypes,intent);
 const approval:MakerApproval={intentHash:hashIntent(domain,intent),executionPrice:100_100_000_000n,impactCharge:0n,fee:20_000n,oracleReportHash:keccak256(toUtf8Bytes('report')),deadline:BigInt(deadline-5),leaderEpoch:1n,signerSetVersion:1n,policyVersion:1n},digest=hashApproval(domain,approval);
 const quote={quoteId,market:'BTC',side:'buy',amount:'100000000',baseDelta:intent.baseDelta.toString(),expectedPrice:approval.executionPrice.toString(),worstPrice:intent.limitPrice.toString(),fee:approval.fee.toString(),impactCharge:'0',spread:{baseBps:'2',volatilityBps:'0',toxicityBps:'0',hedgeBps:'0',basisBps:'0',uncertaintyBps:'0',totalBps:'2',modelVersion:'adaptive-v1'},expiresAtMs:Date.now()+30_000,observedAtMs:Date.now(),bid:'99990000000',ask:'100010000000'} as const;
 const payload={domain:{...domain,chainId:domain.chainId.toString()},intent:intentToWire(intent),userSignature,approval:approvalToWire(approval),quote,report:'0x',oracleAgeMs:0};
 database.prepare("INSERT INTO commitments VALUES(?,?,?,?,?,?,?,?,NULL,?)").run(quoteId,'BTC',quote.amount,deadline*1000,'approved',JSON.stringify(intentToWire(intent)),userSignature,JSON.stringify(approvalToWire(approval)),Date.now());database.prepare('INSERT INTO approval_artifacts VALUES(?,?,?,?)').run(digest,quoteId,JSON.stringify(payload),Date.now());persistGross(database,quoteId,{market:0,baseDelta:intent.baseDelta,reduceOnly:false,deadline:deadline-5,makerDebit:200_000_000n});
 const [restored]=restoreApiCommitments(database,domain);assert.equal(restored.intent.nonce,7n);assert.equal(restored.quote.delta,100_000_000n);assert.equal(restored.userSignature,userSignature);
 archiveApiCommitments(database,[quoteId],1234);assert.equal(database.prepare('SELECT count(*) count FROM commitments').get()!.count,0);assert.equal(database.prepare('SELECT count(*) count FROM approval_artifacts').get()!.count,0);assert.equal(database.prepare('SELECT archived_ms FROM archived_commitments').get()!.archived_ms,1234);assert.equal(database.prepare('SELECT archived_ms FROM archived_approval_artifacts').get()!.archived_ms,1234);database.close();
});

test('API recovery rejects a commitment whose gross reservation was weakened',async()=>{
 const database=new DatabaseSync(':memory:');database.exec("CREATE TABLE commitments(quote_id TEXT PRIMARY KEY,market TEXT NOT NULL,delta TEXT NOT NULL,expires_ms INTEGER NOT NULL,status TEXT NOT NULL,intent_json TEXT NOT NULL,user_signature TEXT NOT NULL,approval_json TEXT,tx_hash TEXT,updated_ms INTEGER NOT NULL)");initializeGrossJournal(database);initializeApiRecoveryJournal(database);
 database.prepare("INSERT INTO commitments VALUES(?,?,?,?,?,?,?,?,NULL,?)").run(crypto.randomUUID(),'BTC','1',Date.now()+60_000,'approved','{}','0x00','{}',Date.now());
 assert.throws(()=>restoreApiCommitments(database,{name:DOMAIN_NAME,version:DOMAIN_VERSION,chainId:84532n,verifyingContract:'0x0000000000000000000000000000000000000001'}),/approval artifact/);database.close();
});
