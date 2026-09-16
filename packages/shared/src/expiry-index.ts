type ExpiryEntry={id:string;expiresAtMs:number};
/** Indexed min-heap: rescheduling/cancellation retain no obsolete entries. */
export class ExpiryIndex {
 private entries:ExpiryEntry[]=[];private indices=new Map<string,number>();
 get size(){return this.entries.length;}
 schedule(id:string,expiresAtMs:number){
  if(!Number.isFinite(expiresAtMs))throw new Error('invalid expiry');
  const index=this.indices.get(id);if(index!==undefined){this.entries[index].expiresAtMs=expiresAtMs;this.repair(index);return;}
  const next=this.entries.length;this.entries.push({id,expiresAtMs});this.indices.set(id,next);this.up(next);
 }
 cancel(id:string){const index=this.indices.get(id);if(index!==undefined)this.remove(index);}
 takeExpired(now=Date.now(),limit=512){const result:string[]=[];while(result.length<limit&&this.entries[0]&&this.entries[0].expiresAtMs<=now)result.push(this.remove(0).id);return result;}
 private remove(index:number){const item=this.entries[index],tail=this.entries.pop()!;this.indices.delete(item.id);if(index<this.entries.length){this.entries[index]=tail;this.indices.set(tail.id,index);this.repair(index);}return item;}
 private repair(index:number){this.down(this.up(index));}
 private swap(left:number,right:number){const item=this.entries[left];this.entries[left]=this.entries[right];this.entries[right]=item;this.indices.set(this.entries[left].id,left);this.indices.set(item.id,right);}
 private up(index:number){while(index>0){const parent=(index-1)>>1;if(this.entries[parent].expiresAtMs<=this.entries[index].expiresAtMs)break;this.swap(parent,index);index=parent;}return index;}
 private down(index:number){while(true){const left=index*2+1;if(left>=this.entries.length)return;const right=left+1,child=right<this.entries.length&&this.entries[right].expiresAtMs<this.entries[left].expiresAtMs?right:left;if(this.entries[index].expiresAtMs<=this.entries[child].expiresAtMs)return;this.swap(index,child);index=child;}}
}
