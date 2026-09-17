export function partialCloseDelta(size:bigint,percentBps:number){
  if(size===0n)throw new Error("position is already closed");
  if(!Number.isSafeInteger(percentBps)||percentBps<1||percentBps>10_000)throw new Error("invalid close percentage");
  const magnitude=size<0n?-size:size,closed=percentBps===10_000?magnitude:magnitude*BigInt(percentBps)/10_000n;
  if(closed===0n)throw new Error("partial close is below base precision");
  return size>0n?-closed:closed;
}
