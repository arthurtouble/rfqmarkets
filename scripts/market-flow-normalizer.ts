export type Market="BTC"|"ETH";
export type TakerSide="buy"|"sell";
export interface NormalizedTrade{timestampMs:number;venue:"coinbase"|"binance";market:Market;tradeId:string;price:number;sizeBase:number;takerSide:TakerSide;bid?:number;ask?:number}

const market=(symbol:unknown):Market|undefined=>symbol==="BTC-USD"||symbol==="BTCUSDT"?"BTC":symbol==="ETH-USD"||symbol==="ETHUSDT"?"ETH":undefined;
const positive=(value:unknown)=>{const number=Number(value);return Number.isFinite(number)&&number>0?number:undefined;};

/** Coinbase Exchange match `side` identifies the resting maker order, so the
 * aggressor direction used for markouts is its opposite. */
export class CoinbaseNormalizer{
  private readonly books:Partial<Record<Market,{bid:number;ask:number}>>={};
  normalize(value:unknown):NormalizedTrade|undefined{
    if(!value||typeof value!=="object")return;const item=value as Record<string,unknown>,selected=market(item.product_id);if(!selected)return;
    if(item.type==="ticker"){const bid=positive(item.best_bid),ask=positive(item.best_ask);if(bid&&ask&&bid<=ask)this.books[selected]={bid,ask};return;}
    const price=positive(item.price),size=positive(item.size),timestamp=Date.parse(String(item.time??""));
    if(item.type!=="match"||!price||!size||!Number.isFinite(timestamp)||item.trade_id===undefined||(item.side!=="buy"&&item.side!=="sell"))return;
    return{timestampMs:timestamp,venue:"coinbase",market:selected,tradeId:String(item.trade_id),price,sizeBase:size,takerSide:item.side==="buy"?"sell":"buy",...this.books[selected]};
  }
}

export class BinanceNormalizer{
  private readonly books:Partial<Record<Market,{bid:number;ask:number}>>={};
  normalize(value:unknown):NormalizedTrade|undefined{
    if(!value||typeof value!=="object")return;const envelope=value as Record<string,unknown>,item=(envelope.data&&typeof envelope.data==="object"?envelope.data:envelope) as Record<string,unknown>,selected=market(item.s);
    if(!selected)return;
    if(item.e===undefined&&item.u!==undefined){const bid=positive(item.b),ask=positive(item.a);if(bid&&ask&&bid<=ask)this.books[selected]={bid,ask};return;}
    const price=positive(item.p),size=positive(item.q),timestamp=Number(item.T),tradeId=item.a;
    if(item.e!=="aggTrade"||!price||!size||!Number.isSafeInteger(timestamp)||timestamp<=0||tradeId===undefined||typeof item.m!=="boolean")return;
    return{timestampMs:timestamp,venue:"binance",market:selected,tradeId:String(tradeId),price,sizeBase:size,takerSide:item.m?"sell":"buy",...this.books[selected]};
  }
}

export const csvHeader="timestamp_ms,venue,market,trade_id,price,size_base,taker_side,bid,ask";
export function toCsv(item:NormalizedTrade){return[item.timestampMs,item.venue,item.market,item.tradeId,item.price,item.sizeBase,item.takerSide,item.bid??"",item.ask??""].join(",");}
