import assert from "node:assert/strict";
import test from "node:test";
import { tradeDetails } from "./trade-history.js";
import type { TradeActivity } from "./types.js";

const fill=(block:number,baseDelta:string,price:string,fee="100000"):TradeActivity=>({tx_hash:`0x${block}`,log_index:0,block_number:block,timestamp:block,kind:"TradeExecuted",account:"0x1",market:0,finality:"finalized",payload:{baseDelta,price,fee}});

test("trade details reconstruct partial-close realized and net PnL",()=>{
  const [close,open]=tradeDetails([fill(1,"2000000000000000000","100000000"),fill(2,"-500000000000000000","110000000","200000")]);
  assert.equal(open.positionAfter,2_000_000_000_000_000_000n);
  assert.equal(close.realizedPnl,5_000_000n);
  assert.equal(close.netRealizedPnl,4_800_000n);
  assert.equal(close.positionAfter,1_500_000_000_000_000_000n);
  assert.equal(close.entryAfter,100_000_000n);
});

test("position-changing risk events keep later trade PnL aligned",()=>{
  const emergency={...fill(2,"-2000000000000000000","90000000","0"),kind:"PositionClosed"};
  const [latest]=tradeDetails([fill(1,"2000000000000000000","100000000"),emergency,fill(3,"-1000000000000000000","80000000"),fill(4,"500000000000000000","70000000")]);
  assert.equal(latest.realizedPnl,5_000_000n);
  assert.equal(latest.positionAfter,-500_000_000_000_000_000n);
  assert.equal(latest.entryAfter,80_000_000n);
});
