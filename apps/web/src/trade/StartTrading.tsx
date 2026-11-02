// Trading needs the trading key: every trade, TP/SL and cash-out signs with it, so no price waits on a wallet
// prompt. Until this browser holds a live key (or after it expires), this button stands in for the trade buttons:
// one wallet signature connects, and everything after runs without the wallet.
import { useTrading } from "../data/actions.js";

export function StartTrading({ label = "Start trading" }: { label?: string }) {
  const trading = useTrading(),
    busy = trading.busy !== null;
  return (
    <>
      <button
        type="button"
        className="rfq-btn rfq-btn--lg rfq-btn--primary rfq-btn--block"
        disabled={busy}
        aria-busy={busy}
        onClick={() => void trading.enableQuickTrading()}
      >
        {busy ? (
          <>
            <span className="rfq-spinner" />
            Confirm in your wallet
          </>
        ) : (
          label
        )}
      </button>
      <p className="footnote rfq-faint center">
        Sign once in your wallet to connect. After that, every trade fills instantly with no wallet prompts.
      </p>
    </>
  );
}
