export type LatencySnapshot={count:number;failures:number;meanMs:number;p50Ms:number;p95Ms:number;p99Ms:number;maxMs:number};

/** Bounded, fixed-label process telemetry. It cannot grow with accounts or quote IDs. */
export class RuntimeMetrics{
  private readonly samples=new Map<string,{count:number;failures:number;sum:number;max:number;recent:number[]}>();
  constructor(private readonly capacity=512){}
  record(label:string,durationMs:number,statusCode=200){
    const value=Math.max(0,Math.round(durationMs*10)/10),item=this.samples.get(label)??{count:0,failures:0,sum:0,max:0,recent:[]};
    item.count++;item.sum+=value;item.max=Math.max(item.max,value);if(statusCode>=500)item.failures++;
    item.recent.push(value);if(item.recent.length>this.capacity)item.recent.splice(0,item.recent.length-this.capacity);
    this.samples.set(label,item);
  }
  snapshot(){
    const result:Record<string,LatencySnapshot>={};
    for(const [label,item] of this.samples){
      const sorted=[...item.recent].sort((a,b)=>a-b),percentile=(ratio:number)=>sorted[Math.min(sorted.length-1,Math.max(0,Math.ceil(sorted.length*ratio)-1))]??0;
      result[label]={count:item.count,failures:item.failures,meanMs:Math.round(item.sum/item.count*10)/10,p50Ms:percentile(.5),p95Ms:percentile(.95),p99Ms:percentile(.99),maxMs:item.max};
    }
    return result;
  }
}
