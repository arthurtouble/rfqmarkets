import assert from "node:assert/strict";
import {test} from "node:test";
import {tradeDetails} from "./trade-activity.js";

test("trade details preserve exact integer PnL for partial closes and flips",()=>{
  const partial=tradeDetails({size:2n*10n**18n,entryPrice:100n*10n**6n},-5n*10n**17n,110n*10n**6n,1n*10n**6n);
  assert.deepEqual({...partial,next:undefined},{positionBefore:(2n*10n**18n).toString(),entryPriceBefore:(100n*10n**6n).toString(),positionAfter:(15n*10n**17n).toString(),entryPriceAfter:(100n*10n**6n).toString(),notional:(55n*10n**6n).toString(),realizedPnl:(5n*10n**6n).toString(),netRealizedPnl:(4n*10n**6n).toString(),next:undefined});
  const flip=tradeDetails({size:-1n*10n**18n,entryPrice:100n*10n**6n},2n*10n**18n,90n*10n**6n);
  assert.equal(flip.realizedPnl,(10n*10n**6n).toString());assert.equal(flip.positionAfter,(1n*10n**18n).toString());assert.equal(flip.entryPriceAfter,(90n*10n**6n).toString());
});
