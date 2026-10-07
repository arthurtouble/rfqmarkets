import { useState } from "react";
import { useTrading } from "../data/actions.js";
import { abs, baseAmount, usdc } from "../lib/format.js";
import type { Market, Quote, Side } from "../lib/types.js";
import { MARKET_NAMES, Rows, Sheet } from "../ui/primitives.js";
import { QUICK_LIMITS } from "../wallet/quick-session.js";

/** Restates a market order in plain words before the wallet signature. */
export function ReviewSheet({ market, side, amountMicro, quote, reduceOnly, onClose, onDone }: {
  market: Market; side: Side; amountMicro: bigint; quote: Quote; reduceOnly: boolean; onClose: () => void; onDone: () => void;
}) {
  const trading = useTrading();
  const offerOneClick = !trading.quickSession?.privateKey;
  const [oneClick, setOneClick] = useState(offerOneClick);
  const busy = trading.busy !== null;
  const word = side === "buy" ? "Long" : "Short";
  const base = quote.baseDelta ? `${baseAmount(abs(BigInt(quote.baseDelta)))} ${market}` : market;
  const confirm = async () => {
    await trading.marketOrder({ market, side, amountMicro, reduceOnly });
    if (oneClick && offerOneClick) await trading.enableQuickTrading();
    onDone();
  };
  return <Sheet open onClose={onClose} title="Review order" labelledBy="review-title">
    <div className="sheet-body">
      <p className="body review-sentence">{word} <b className="tnum">{base}</b> on {MARKET_NAMES[market]} for <b className="tnum">{usdc(amountMicro)}</b>. It fills at this price or better, or not at all.</p>
      <Rows rows={[
        ["Entry price", usdc(quote.expectedPrice)],
        ["Price protection", usdc(quote.worstPrice)],
        ["Fee", usdc(quote.fee)],
        ["Position size", usdc(amountMicro), "is-total"],
      ]} />
      {offerOneClick && <label className="check-row">
        <input type="checkbox" checked={oneClick} onChange={event => setOneClick(event.target.checked)} />
        <span>Then turn on one-click trading<span className="footnote rfq-faint"> · trades up to ${QUICK_LIMITS.maxTradeAmount} skip this step for 8 hours (one more signature)</span></span>
      </label>}
      <button type="button" className={`rfq-btn rfq-btn--lg rfq-btn--block rfq-btn--${side === "buy" ? "long" : "short"}`} disabled={busy} onClick={confirm}>
        {busy ? <><span className="rfq-spinner" />Confirm in your wallet</> : "Confirm and sign"}
      </button>
      <p className="footnote rfq-faint sheet-note center">No gas needed. The price is checked again when you sign.</p>
    </div>
  </Sheet>;
}
