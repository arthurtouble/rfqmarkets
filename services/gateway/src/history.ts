export type HistoryMarket="BTC"|"ETH";
export type HistoryPoint={observedAtMs:number;mid:string;bid:string;ask:string};

/** Bounded, disposable chart context. It is never an accounting or pricing ledger. */
export class MarketHistory {
  private points:Record<HistoryMarket,HistoryPoint[]>={BTC:[],ETH:[]};
  constructor(private readonly capacity=1_800,private readonly sampleIntervalMs=1_000){
    if(!Number.isInteger(capacity)||capacity<2)throw new Error("history capacity must be at least 2");
    if(!Number.isInteger(sampleIntervalMs)||sampleIntervalMs<0)throw new Error("history sample interval must be nonnegative");
  }
  record(frame:string){
    let value:unknown;try{value=JSON.parse(frame);}catch{return;}
    if(!value||typeof value!=="object")return;
    const markets=(value as {markets?:unknown}).markets;if(!markets||typeof markets!=="object")return;
    for(const market of ["BTC","ETH"] as const){
      const raw=(markets as Record<string,unknown>)[market];if(!raw||typeof raw!=="object")continue;
      const item=raw as Record<string,unknown>,observedAtMs=Number(item.observedAtMs),mid=String(item.mid??""),bid=String(item.bid??""),ask=String(item.ask??"");
      if(!Number.isFinite(observedAtMs)||observedAtMs<=0||!/^\d+$/.test(mid)||!/^\d+$/.test(bid)||!/^\d+$/.test(ask))continue;
      const list=this.points[market],last=list.at(-1);if(last&&observedAtMs-last.observedAtMs<this.sampleIntervalMs)continue;
      list.push({observedAtMs,mid,bid,ask});if(list.length>this.capacity)list.splice(0,list.length-this.capacity);
    }
  }
  get(market:HistoryMarket,limit=this.capacity){
    const bounded=Math.max(2,Math.min(this.capacity,Number.isFinite(limit)?Math.floor(limit):this.capacity));
    return this.points[market].slice(-bounded);
  }
  status(){return {capacity:this.capacity,sampleIntervalMs:this.sampleIntervalMs,points:{BTC:this.points.BTC.length,ETH:this.points.ETH.length}};}
}
