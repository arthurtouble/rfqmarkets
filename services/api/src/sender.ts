import { DatabaseSync } from "node:sqlite";
import { JsonRpcProvider, Transaction, Wallet, keccak256, type TransactionRequest } from "ethers";

export interface IncludedReceipt { hash:string; blockNumber:number; blockHash:string; status:1 }
export interface SenderOptions { firstWaitMs?:number; replacementWaitMs?:number; pollMs?:number; maxReplacements?:number; bumpBps?:number; initialFeeBumpBps?:number; chainId?:bigint }
interface StoredTransaction {operation_id:string;nonce:number;tx_hash:string;raw_tx:string;status:string;included_hash:string|null}

export class DurableSender{
  private tail:Promise<unknown>=Promise.resolve();
  constructor(private provider:JsonRpcProvider,private wallet:Wallet,private database?:DatabaseSync,private options:SenderOptions={}){
    database?.exec("CREATE TABLE IF NOT EXISTS sender_transactions(operation_id TEXT PRIMARY KEY,nonce INTEGER NOT NULL,tx_hash TEXT NOT NULL UNIQUE,raw_tx TEXT NOT NULL,status TEXT NOT NULL,included_block INTEGER,included_hash TEXT,updated_ms INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS sender_attempts(operation_id TEXT NOT NULL,attempt INTEGER NOT NULL,nonce INTEGER NOT NULL,tx_hash TEXT NOT NULL UNIQUE,raw_tx TEXT NOT NULL,created_ms INTEGER NOT NULL,PRIMARY KEY(operation_id,attempt)); INSERT OR IGNORE INTO sender_attempts SELECT operation_id,0,nonce,tx_hash,raw_tx,updated_ms FROM sender_transactions");
  }
  submit(operationId:string,request:TransactionRequest){const run=this.tail.then(()=>this.submitLocked(operationId,request));this.tail=run.catch(()=>undefined);return run;}
  private async submitLocked(operationId:string,request:TransactionRequest){
    let stored=this.database?.prepare("SELECT operation_id,nonce,tx_hash,raw_tx,status,included_hash FROM sender_transactions WHERE operation_id=?").get(operationId) as StoredTransaction|undefined;
    let attempt=Number((this.database?.prepare("SELECT max(attempt) value FROM sender_attempts WHERE operation_id=?").get(operationId) as {value:number|null}|undefined)?.value??0);
    if(stored){const included=await this.findIncluded(operationId);if(included){this.recordReceipt(operationId,included.receipt,included.raw);return included.receipt;}await this.broadcast(stored.raw_tx);}
    else {
      const [nonceHex,fees]=await Promise.all([this.provider.send("eth_getTransactionCount",[this.wallet.address,"pending"]),this.options.chainId&&request.gasLimit!==undefined?this.provider.getFeeData():Promise.resolve(undefined)]),nonce=Number(BigInt(nonceHex));let populated:TransactionRequest;
      if(this.options.chainId&&request.gasLimit!==undefined&&fees){populated={...request,nonce,chainId:this.options.chainId};if(request.maxFeePerGas===undefined&&request.gasPrice===undefined){const feeBump=(value:bigint)=>value*BigInt(10_000+(this.options.initialFeeBumpBps??0))/10_000n+1n;if(fees.maxFeePerGas!==null&&fees.maxPriorityFeePerGas!==null)populated={...populated,type:2,maxFeePerGas:feeBump(fees.maxFeePerGas),maxPriorityFeePerGas:feeBump(fees.maxPriorityFeePerGas)};else if(fees.gasPrice!==null)populated={...populated,type:0,gasPrice:feeBump(fees.gasPrice)};else throw new Error("fee data unavailable");}}
      else populated=await this.wallet.populateTransaction({...request,from:this.wallet.address,nonce});
      const raw=await this.wallet.signTransaction(populated),hash=keccak256(raw);
      stored={operation_id:operationId,nonce,tx_hash:hash,raw_tx:raw,status:"signed",included_hash:null};this.writeInitial(stored);await this.broadcast(raw);this.markSubmitted(operationId);
    }
    const maxReplacements=this.options.maxReplacements??1;
    for(let replacement=0;replacement<=maxReplacements;replacement++){
      const receipt=await this.wait(stored.tx_hash,replacement===0?(this.options.firstWaitMs??8_000):(this.options.replacementWaitMs??30_000));
      if(receipt){this.recordReceipt(operationId,receipt,stored.raw_tx);return receipt;}
      const included=await this.findIncluded(operationId);if(included){this.recordReceipt(operationId,included.receipt,included.raw);return included.receipt;}
      if(replacement===maxReplacements)break;
      stored=await this.replace(stored,++attempt);await this.broadcast(stored.raw_tx);this.markSubmitted(operationId);
    }
    throw new Error(`transaction for ${operationId} was not included after ${maxReplacements+1} attempts`);
  }
  private writeInitial(row:StoredTransaction){if(!this.database)return;this.database.exec("BEGIN IMMEDIATE");try{this.database.prepare("INSERT INTO sender_transactions VALUES(?,?,?,?, 'signed',NULL,NULL,?)").run(row.operation_id,row.nonce,row.tx_hash,row.raw_tx,Date.now());this.database.prepare("INSERT INTO sender_attempts VALUES(?,?,?,?,?,?)").run(row.operation_id,0,row.nonce,row.tx_hash,row.raw_tx,Date.now());this.database.exec("COMMIT");}catch(error){this.database.exec("ROLLBACK");throw error;}}
  private async replace(current:StoredTransaction,attempt:number){
    const transaction=Transaction.from(current.raw_tx),bump=(value:bigint)=>value*BigInt(10_000+(this.options.bumpBps??1_500))/10_000n+1n,fees=await this.provider.getFeeData();
    let request:TransactionRequest={to:transaction.to,data:transaction.data,value:transaction.value,gasLimit:transaction.gasLimit,nonce:transaction.nonce,chainId:transaction.chainId};
    if(transaction.type===2){const priority=this.maximum(bump(transaction.maxPriorityFeePerGas??0n),fees.maxPriorityFeePerGas??0n),maxFee=this.maximum(bump(transaction.maxFeePerGas??0n),fees.maxFeePerGas??0n,priority);request={...request,type:2,maxPriorityFeePerGas:priority,maxFeePerGas:maxFee,accessList:transaction.accessList};}
    else request={...request,type:0,gasPrice:this.maximum(bump(transaction.gasPrice??0n),fees.gasPrice??0n)};
    const raw=await this.wallet.signTransaction(request),hash=keccak256(raw),next:StoredTransaction={...current,tx_hash:hash,raw_tx:raw,status:"signed",included_hash:null};
    if(this.database){this.database.exec("BEGIN IMMEDIATE");try{this.database.prepare("INSERT INTO sender_attempts VALUES(?,?,?,?,?,?)").run(current.operation_id,attempt,current.nonce,hash,raw,Date.now());this.database.prepare("UPDATE sender_transactions SET tx_hash=?,raw_tx=?,status='signed',included_block=NULL,included_hash=NULL,updated_ms=? WHERE operation_id=?").run(hash,raw,Date.now(),current.operation_id);this.database.exec("COMMIT");}catch(error){this.database.exec("ROLLBACK");throw error;}}
    return next;
  }
  private maximum(...values:bigint[]){return values.reduce((best,value)=>value>best?value:best,0n);}
  private async broadcast(raw:string){try{await this.provider.broadcastTransaction(raw);}catch(error){const message=String(error);if(!message.includes("already known")&&!message.includes("nonce too low"))throw error;}}
  private markSubmitted(operationId:string){this.database?.prepare("UPDATE sender_transactions SET status='submitted',updated_ms=? WHERE operation_id=?").run(Date.now(),operationId);}
  private async wait(hash:string,timeoutMs:number){const deadline=Date.now()+timeoutMs;while(Date.now()<deadline){const receipt=await this.readReceipt(hash);if(receipt)return receipt;await new Promise(resolve=>setTimeout(resolve,this.options.pollMs??100));}return null;}
  private async readReceipt(hash:string){const raw=await this.provider.send("eth_getTransactionReceipt",[hash]) as null|{transactionHash:string;blockNumber:string;blockHash:string;status:string};if(!raw)return null;if(BigInt(raw.status)!==1n)throw new Error(`transaction ${hash} reverted`);return {hash:raw.transactionHash,blockNumber:Number(BigInt(raw.blockNumber)),blockHash:raw.blockHash,status:1} as IncludedReceipt;}
  private async findIncluded(operationId:string){if(!this.database)return null;const rows=this.database.prepare("SELECT tx_hash,raw_tx FROM sender_attempts WHERE operation_id=? ORDER BY attempt").all(operationId) as Array<{tx_hash:string;raw_tx:string}>;const receipts=await Promise.all(rows.map(row=>this.readReceipt(row.tx_hash)));const index=receipts.findIndex(Boolean);return index<0?null:{receipt:receipts[index]!,raw:rows[index].raw_tx};}
  private recordReceipt(operationId:string,receipt:IncludedReceipt,raw?:string){this.database?.prepare("UPDATE sender_transactions SET tx_hash=?,raw_tx=COALESCE(?,raw_tx),status='included',included_block=?,included_hash=?,updated_ms=? WHERE operation_id=?").run(receipt.hash,raw??null,receipt.blockNumber,receipt.blockHash,Date.now(),operationId);}
  async reconcile(){
    if(!this.database)return;const rows=this.database.prepare("SELECT operation_id,nonce,tx_hash,raw_tx,status,included_hash FROM sender_transactions WHERE status IN ('signed','submitted','included','reorged')").all() as unknown as StoredTransaction[];
    const attempts=this.database.prepare("SELECT operation_id,tx_hash,raw_tx FROM sender_attempts ORDER BY operation_id,attempt").all() as Array<{operation_id:string;tx_hash:string;raw_tx:string}>,receipts=await Promise.all(attempts.map(row=>this.readReceipt(row.tx_hash).catch(()=>null))),included=new Map<string,{receipt:IncludedReceipt;raw:string}>();
    for(let index=0;index<attempts.length;index++)if(receipts[index])included.set(attempts[index].operation_id,{receipt:receipts[index]!,raw:attempts[index].raw_tx});
    const pending=Number(BigInt(await this.provider.send("eth_getTransactionCount",[this.wallet.address,"pending"])));
    for(const row of rows){const found=included.get(row.operation_id);if(found&&(!row.included_hash||found.receipt.blockHash===row.included_hash)){this.recordReceipt(row.operation_id,found.receipt,found.raw);continue;}if(row.nonce<pending){const replacement=this.database.prepare("SELECT operation_id FROM sender_transactions WHERE nonce=? AND status='included' LIMIT 1").get(row.nonce) as {operation_id:string}|undefined;this.database.prepare("UPDATE sender_transactions SET status=?,included_block=NULL,included_hash=NULL,updated_ms=? WHERE operation_id=?").run(replacement?"superseded":"ambiguous",Date.now(),row.operation_id);continue;}try{await this.broadcast(row.raw_tx);this.markSubmitted(row.operation_id);}catch{this.database.prepare("UPDATE sender_transactions SET status='ambiguous',updated_ms=? WHERE operation_id=?").run(Date.now(),row.operation_id);}}
  }
  status(){if(!this.database)return [];return this.database.prepare("SELECT status,count(*) count FROM sender_transactions GROUP BY status ORDER BY status").all();}
}
