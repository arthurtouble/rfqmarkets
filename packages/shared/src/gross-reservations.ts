import {ExpiryIndex} from './expiry-index.js';
import type {ExposureBook} from './exposure-admission.js';
export interface GrossReservation {market:0|1;baseDelta:bigint;reduceOnly:boolean;deadline:number}
export function assertGrossReservation(input:GrossReservation){if(typeof input.baseDelta!=="bigint"||typeof input.reduceOnly!=="boolean"||!Number.isSafeInteger(input.deadline*1000)||input.deadline<0||!input.baseDelta||input.market!==0&&input.market!==1)throw new Error('invalid gross reservation');}
const BASE=10n**18n,MASK=(1n<<128n)-1n;
/** Signatures retain capacity through inclusion; only finalized expiry releases it. */
export class GrossReservationBook {
 private items=new Map<string,GrossReservation>();private expiry=new ExpiryIndex();
 private totals=[{longBase:0n,shortBase:0n},{longBase:0n,shortBase:0n}];
 finalizedBlock=-1;finalizedTimestamp=0;finalizedHash?:string;
 get size(){return this.items.size;}
 get(id:string){return this.items.get(id);}
 reserve(id:string,input:GrossReservation){
  assertGrossReservation(input);
  const old=this.items.get(id);if(old&&(old.market!==input.market||old.baseDelta!==input.baseDelta||old.reduceOnly!==input.reduceOnly))throw new Error('gross reservation input mismatch');
  const item={...input,deadline:Math.max(old?.deadline??0,input.deadline)};
  if(!old){this.items.set(id,item);this.adjust(item,1n);}else this.items.set(id,item);
  if(!old||item.deadline!==old.deadline)this.expiry.schedule(id,item.deadline*1000);
 }
 finalize(block:number,timestamp:number,limit=512,hash?:string){
  if(!Number.isSafeInteger(block)||!Number.isSafeInteger(timestamp)||block<this.finalizedBlock||timestamp<this.finalizedTimestamp)throw new Error('finalized clock regression');
  if(block===this.finalizedBlock&&(timestamp!==this.finalizedTimestamp||(hash&&this.finalizedHash&&hash.toLowerCase()!==this.finalizedHash.toLowerCase())))throw new Error('conflicting finalized header');
  this.finalizedHash=hash??(block===this.finalizedBlock?this.finalizedHash:undefined);this.finalizedBlock=block;this.finalizedTimestamp=timestamp;
  const expired=this.expiry.takeExpired(timestamp*1000-1,limit);for(const id of expired){const item=this.items.get(id)!;this.adjust(item,-1n);this.items.delete(id);}return expired;
 }
 bounds(exclude?:string){const result=this.totals.map(item=>({...item}));const old=exclude?this.items.get(exclude):undefined;if(old&&!old.reduceOnly){const side=old.baseDelta>0n?'longBase':'shortBase';result[old.market][side]-=old.baseDelta>0n?old.baseDelta:-old.baseDelta;}return result;}
 admit(id:string,item:GrossReservation,books:[ExposureBook,ExposureBook],asks:[bigint,bigint],blockNumber:number){
  assertGrossReservation(item);if(blockNumber<this.finalizedBlock)return false;
  if(!books.every(book=>book.ready))return false;
  const old=this.items.get(id);if(old&&(old.market!==item.market||old.baseDelta!==item.baseDelta||old.reduceOnly!==item.reduceOnly))return false;
  // The on-chain reduceOnly invariant guarantees zero additional gross capacity.
  if(item.reduceOnly)return true;
  const totals=this.bounds(id),side=item.baseDelta>0n?'longBase':'shortBase';totals[item.market][side]+=item.baseDelta>0n?item.baseDelta:-item.baseDelta;
  for(let market=0;market<2;market++){
   const book=books[market],long=book.longBase+totals[market].longBase,short=book.shortBase+totals[market].shortBase,ask=asks[market];
   if((long+short>0n&&ask<=0n)||(long+short)*ask/BASE>(book.limits&MASK)||long*ask/BASE>book.limits>>128n||short*ask/BASE>book.limits>>128n)return false;
  }return true;
 }
 private adjust(item:GrossReservation,sign:bigint){if(item.reduceOnly)return;const side=item.baseDelta>0n?'longBase':'shortBase';this.totals[item.market][side]+=(item.baseDelta>0n?item.baseDelta:-item.baseDelta)*sign;}
}
