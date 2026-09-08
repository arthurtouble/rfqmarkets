import { DatabaseSync } from "node:sqlite";
import { JsonRpcProvider, Wallet, keccak256, type TransactionRequest } from "ethers";

export interface IncludedReceipt { hash:string; blockNumber:number; blockHash:string; status:1 }

export class DurableSender{
  private tail:Promise<unknown>=Promise.resolve();
  constructor(private provider:JsonRpcProvider,private wallet:Wallet,private database?:DatabaseSync){
    database?.exec("CREATE TABLE IF NOT EXISTS sender_transactions(operation_id TEXT PRIMARY KEY,nonce INTEGER NOT NULL,tx_hash TEXT NOT NULL UNIQUE,raw_tx TEXT NOT NULL,status TEXT NOT NULL,included_block INTEGER,included_hash TEXT,updated_ms INTEGER NOT NULL)");
  }
  submit(operationId:string,request:TransactionRequest){const run=this.tail.then(()=>this.submitLocked(operationId,request));this.tail=run.catch(()=>undefined);return run;}
  private async submitLocked(operationId:string,request:TransactionRequest){
    const existing=this.database?.prepare("SELECT * FROM sender_transactions WHERE operation_id=?").get(operationId) as {nonce:number;tx_hash:string;raw_tx:string;status:string;included_block:number|null;included_hash:string|null}|undefined;
    if(existing){const receipt=await this.provider.getTransactionReceipt(existing.tx_hash);if(receipt&&receipt.status===1&&(!existing.included_hash||receipt.blockHash===existing.included_hash)){const included=this.normalize(receipt);this.recordReceipt(operationId,included);return included;}try{await this.provider.broadcastTransaction(existing.raw_tx);}catch(error){if(!String(error).includes("already known")&&!String(error).includes("nonce too low"))throw error;}return this.wait(operationId,existing.tx_hash);}
    const pendingNonce=Number(BigInt(await this.provider.send("eth_getTransactionCount",[this.wallet.address,"pending"])));
    const populated=await this.wallet.populateTransaction({...request,from:this.wallet.address,nonce:pendingNonce});const raw=await this.wallet.signTransaction(populated);const hash=keccak256(raw);
    this.database?.prepare("INSERT INTO sender_transactions VALUES(?,?,?,?, 'signed',NULL,NULL,?)").run(operationId,Number(populated.nonce),hash,raw,Date.now());
    try{await this.provider.broadcastTransaction(raw);}catch(error){if(!String(error).includes("already known"))throw error;}
    this.database?.prepare("UPDATE sender_transactions SET status='submitted',updated_ms=? WHERE operation_id=?").run(Date.now(),operationId);return this.wait(operationId,hash);
  }
  private async wait(operationId:string,hash:string){
    const deadline=Date.now()+30_000;
    while(Date.now()<deadline){
      const raw=await this.provider.send("eth_getTransactionReceipt",[hash]) as null|{transactionHash:string;blockNumber:string;blockHash:string;status:string};
      if(raw){if(BigInt(raw.status)!==1n)throw new Error(`transaction ${hash} reverted`);const receipt:IncludedReceipt={hash:raw.transactionHash,blockNumber:Number(BigInt(raw.blockNumber)),blockHash:raw.blockHash,status:1};this.recordReceipt(operationId,receipt);return receipt;}
      await new Promise(resolve=>setTimeout(resolve,50));
    }
    throw new Error(`transaction ${hash} was not included within 30 seconds`);
  }
  private normalize(receipt:{hash:string;blockNumber:number;blockHash:string}):IncludedReceipt{return {hash:receipt.hash,blockNumber:receipt.blockNumber,blockHash:receipt.blockHash,status:1};}
  private recordReceipt(operationId:string,receipt:IncludedReceipt){this.database?.prepare("UPDATE sender_transactions SET status='included',included_block=?,included_hash=?,updated_ms=? WHERE operation_id=?").run(receipt.blockNumber,receipt.blockHash,Date.now(),operationId);}
  async reconcile(){if(!this.database)return;const rows=this.database.prepare("SELECT operation_id,nonce,tx_hash,raw_tx,status,included_hash FROM sender_transactions WHERE status IN ('signed','submitted','included','reorged')").all() as Array<{operation_id:string;nonce:number;tx_hash:string;raw_tx:string;status:string;included_hash:string|null}>;for(const row of rows){const receipt=await this.provider.getTransactionReceipt(row.tx_hash);if(receipt?.status===1){this.recordReceipt(row.operation_id,this.normalize(receipt));continue;}const pending=Number(BigInt(await this.provider.send("eth_getTransactionCount",[this.wallet.address,"pending"])));if(row.nonce<pending){const replacement=this.database.prepare("SELECT operation_id FROM sender_transactions WHERE nonce=? AND status='included' LIMIT 1").get(row.nonce) as {operation_id:string}|undefined;this.database.prepare("UPDATE sender_transactions SET status=?,included_block=NULL,included_hash=NULL,updated_ms=? WHERE operation_id=?").run(replacement?"superseded":"ambiguous",Date.now(),row.operation_id);continue;}try{await this.provider.broadcastTransaction(row.raw_tx);this.database.prepare("UPDATE sender_transactions SET status='submitted',updated_ms=? WHERE operation_id=?").run(Date.now(),row.operation_id);}catch{this.database.prepare("UPDATE sender_transactions SET status='ambiguous',updated_ms=? WHERE operation_id=?").run(Date.now(),row.operation_id);}}}
  status(){if(!this.database)return [];return this.database.prepare("SELECT status,count(*) count FROM sender_transactions GROUP BY status ORDER BY status").all();}
}
