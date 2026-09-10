export type ExposureMarket = "BTC" | "ETH";

type ExpiryEntry = { id:string; expiresAtMs:number; sequence:number };

class ExpiryHeap {
  private entries:ExpiryEntry[]=[];
  peek(){return this.entries[0];}
  push(entry:ExpiryEntry){
    this.entries.push(entry);let index=this.entries.length-1;
    while(index>0){const parent=(index-1)>>1;if(this.entries[parent].expiresAtMs<=entry.expiresAtMs)break;this.entries[index]=this.entries[parent];index=parent;}this.entries[index]=entry;
  }
  pop(){
    const root=this.entries[0],tail=this.entries.pop();if(!root||!tail||this.entries.length===0)return root;
    let index=0;while(true){const left=index*2+1;if(left>=this.entries.length)break;const right=left+1,child=right<this.entries.length&&this.entries[right].expiresAtMs<this.entries[left].expiresAtMs?right:left;if(this.entries[child].expiresAtMs>=tail.expiresAtMs)break;this.entries[index]=this.entries[child];index=child;}this.entries[index]=tail;return root;
  }
}

/** Tracks expirations without scanning the objects it indexes. Superseded heap entries are discarded lazily. */
export class ExpiryIndex {
  private sequence=0;
  private active=new Map<string,{expiresAtMs:number;sequence:number}>();
  private heap=new ExpiryHeap();
  schedule(id:string,expiresAtMs:number){const item={expiresAtMs,sequence:++this.sequence};this.active.set(id,item);this.heap.push({id,...item});}
  cancel(id:string){this.active.delete(id);}
  takeExpired(now=Date.now(),limit=512){
    const ids:string[]=[];
    while(ids.length<limit){const top=this.heap.peek();if(!top||top.expiresAtMs>now)break;this.heap.pop();const current=this.active.get(top.id);if(!current||current.sequence!==top.sequence)continue;this.active.delete(top.id);ids.push(top.id);}
    return ids;
  }
}

type PendingItem={market:ExposureMarket;delta:bigint;expiresAtMs:number};

/** Constant-time reservation totals used by the pricing path. */
export class PendingExposureBook {
  private items=new Map<string,PendingItem>();
  private expiries=new ExpiryIndex();
  private totals:Record<ExposureMarket,{low:bigint;high:bigint}>={BTC:{low:0n,high:0n},ETH:{low:0n,high:0n}};
  get size(){return this.items.size;}
  has(id:string){return this.items.has(id);}
  add(id:string,item:PendingItem){this.delete(id);this.items.set(id,item);this.adjust(item,1n);this.expiries.schedule(id,item.expiresAtMs);}
  delete(id:string){const item=this.items.get(id);if(!item)return false;this.items.delete(id);this.expiries.cancel(id);this.adjust(item,-1n);return true;}
  prune(now=Date.now(),limit=512){for(const id of this.expiries.takeExpired(now,limit)){const item=this.items.get(id);if(item){this.items.delete(id);this.adjust(item,-1n);}}}
  exposure(){const result:Array<{market:ExposureMarket;delta:bigint}>=[];for(const market of ["BTC","ETH"] as const){const value=this.totals[market];if(value.low)result.push({market,delta:value.low});if(value.high)result.push({market,delta:value.high});}return result;}
  envelope(){return this.exposure().map(item=>({...item,delta:item.delta.toString()}));}
  private adjust(item:PendingItem,multiplier:bigint){if(item.delta<0n)this.totals[item.market].low+=item.delta*multiplier;else this.totals[item.market].high+=item.delta*multiplier;}
}
