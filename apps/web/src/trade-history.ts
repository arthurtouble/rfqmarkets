import type { Market, TradeActivity } from "./types.js";
import { positionPnl } from "../../../packages/shared/src/account-risk.js";

export type TradeDetail = {
  activity: TradeActivity;
  market: Market;
  side: "Buy" | "Sell";
  quantity: bigint;
  notional: bigint;
  fee: bigint;
  realizedPnl: bigint;
  netRealizedPnl: bigint;
  positionAfter: bigint;
  entryAfter: bigint;
};

/** Replays fills with the same integer rounding as RFQRiskMath.positionTransition. */
export function tradeDetails(activity: TradeActivity[]): TradeDetail[] {
  const positions: Record<Market, { size: bigint; entry: bigint }> = { BTC: { size: 0n, entry: 0n }, ETH: { size: 0n, entry: 0n } };
  const ordered = [...activity].sort((a, b) => a.block_number - b.block_number || a.log_index - b.log_index), details:TradeDetail[]=[];
  for (const item of ordered) {
    const market: Market = item.market === 0 ? "BTC" : "ETH", current = positions[market];
    if(item.kind==="Liquidated"){
      const closed=BigInt(item.payload.closedBase??"0"),delta=current.size>0n?-closed:closed,nextSize=current.size+delta;
      positions[market]={size:nextSize,entry:nextSize===0n?0n:current.entry};continue;
    }
    if(item.kind!=="TradeExecuted"&&item.kind!=="PositionClosed")continue;
    const delta = BigInt(item.payload.baseDelta), price = BigInt(item.payload.price), fee = item.kind==="TradeExecuted"?BigInt(item.payload.fee):0n, nextSize = current.size + delta;
    let entryAfter = current.entry, realizedPnl = 0n;
    if (current.size === 0n || (current.size > 0n) === (delta > 0n)) {
      const combined = nextSize < 0n ? -nextSize : nextSize;
      entryAfter = combined === 0n ? 0n : ((current.size < 0n ? -current.size : current.size) * current.entry + (delta < 0n ? -delta : delta) * price) / combined;
    } else {
      const oldQuantity = current.size < 0n ? -current.size : current.size, deltaQuantity = delta < 0n ? -delta : delta, closed = deltaQuantity < oldQuantity ? deltaQuantity : oldQuantity;
      realizedPnl = positionPnl(current.size < 0n ? -closed : closed, current.entry, price);
      entryAfter = nextSize === 0n ? 0n : (nextSize > 0n) !== (current.size > 0n) ? price : current.entry;
    }
    positions[market] = { size: nextSize, entry: entryAfter };
    if(item.kind!=="TradeExecuted")continue;
    const quantity = delta < 0n ? -delta : delta;
    details.push({ activity: item, market, side: delta > 0n ? "Buy" : "Sell", quantity, notional: quantity * price / 10n ** 18n, fee, realizedPnl, netRealizedPnl: realizedPnl - fee, positionAfter: nextSize, entryAfter });
  }
  return details.reverse();
}
