import type { Market, PriceSnapshot } from "../../../packages/shared/src/pricing.js";

type Fill={side:"buy"|"sell";price:bigint;notional:bigint;atMs:number};

/** Market-wide post-trade markout estimator. Quote requests never enter this state. */
export class FlowRiskTracker{
  private fills:Record<Market,Fill[]>={BTC:[],ETH:[]};
  constructor(private readonly capacity=256,private readonly halfLifeMs=30_000){}
  record(market:Market,fill:Fill){const items=this.fills[market];items.push(fill);if(items.length>this.capacity)items.splice(0,items.length-this.capacity);}
  score(market:Market,snapshot:PriceSnapshot,nowMs=Date.now()){
    const mid=(snapshot.bid+snapshot.ask)/2n;if(mid<=0n)return 10_000;
    let weighted=0,total=0;
    for(const fill of this.fills[market]){
      const age=nowMs-fill.atMs;if(age<250||age>this.halfLifeMs*8)continue;
      const move=fill.side==="buy"?mid-fill.price:fill.price-mid;
      const adverseBps=move>0n?Number(move*10_000n/fill.price):0;
      const recency=Math.pow(.5,age/this.halfLifeMs);
      const sizeWeight=Math.min(4,Math.max(.25,Number(fill.notional)/100_000_000_000));
      const weight=recency*sizeWeight;weighted+=Math.min(1,adverseBps/10)*weight;total+=weight;
    }
    return total?Math.round(Math.min(1,weighted/total)*10_000):0;
  }
  size(market:Market){return this.fills[market].length;}
}
