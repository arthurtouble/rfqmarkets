/** Admission before SSE hijacking, with idempotent lease release. No idle IDs retained. */
export class ConnectionBudget {
 private clients=new Map<string,number>();private active=0;
 constructor(private maximum=10_000,private perClient=8){if(!Number.isInteger(maximum)||maximum<1||!Number.isInteger(perClient)||perClient<1)throw new Error('invalid connection budget');}
 acquire(client:string){const prior=this.clients.get(client)??0;if(this.active>=this.maximum||prior>=this.perClient)return undefined;this.active++;this.clients.set(client,prior+1);let released=false;return ()=>{if(released)return;released=true;this.active--;const count=this.clients.get(client)!-1;if(count)this.clients.set(client,count);else this.clients.delete(client);};}
 status(){return {active:this.active,clients:this.clients.size,maximum:this.maximum,perClient:this.perClient};}
}
