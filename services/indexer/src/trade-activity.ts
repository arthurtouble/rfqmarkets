const BASE=10n**18n;
const abs=(value:bigint)=>value<0n?-value:value;

export type IndexedPosition={size:bigint;entryPrice:bigint};

export function tradeDetails(position:IndexedPosition,baseDelta:bigint,price:bigint,fee=0n){
  const nextSize=position.size+baseDelta;
  let nextEntry=position.entryPrice,realizedPnl=0n;
  if(position.size===0n||(position.size>0n)===(baseDelta>0n)){
    const combined=abs(nextSize);nextEntry=combined===0n?0n:(abs(position.size)*position.entryPrice+abs(baseDelta)*price)/combined;
  }else{
    const closed=abs(baseDelta)<abs(position.size)?abs(baseDelta):abs(position.size);
    realizedPnl=position.size>0n?closed*price/BASE-closed*position.entryPrice/BASE:closed*position.entryPrice/BASE-closed*price/BASE;
    nextEntry=nextSize===0n?0n:(nextSize>0n)!==(position.size>0n)?price:position.entryPrice;
  }
  return {positionBefore:position.size.toString(),entryPriceBefore:position.entryPrice.toString(),positionAfter:nextSize.toString(),entryPriceAfter:nextEntry.toString(),notional:(abs(baseDelta)*price/BASE).toString(),realizedPnl:realizedPnl.toString(),netRealizedPnl:(realizedPnl-fee).toString(),next:{size:nextSize,entryPrice:nextEntry}};
}
