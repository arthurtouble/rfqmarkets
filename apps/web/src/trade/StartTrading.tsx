// Trading needs the one-tap key: every trade, TP/SL and cash-out signs with it, so no price waits on a wallet
// prompt. Until this browser holds a live key (or after it expires), this button stands in for the trade buttons:
// one wallet signature grants the key, and everything after runs without the wallet.
import { useTrading } from "../data/actions.js";
import { useQuickLimits } from "../data/quick-limits.js";
import { QUICK_DAYS } from "../wallet/quick-session.js";

export function StartTrading({ label = "Start trading" }: { label?: string }) {
  const trading = useTrading(),
    limits = useQuickLimits(),
    busy = trading.busy !== null;
  return (
    <>
      <button
        type="button"
        className="rfq-btn rfq-btn--lg rfq-btn--primary rfq-btn--block"
        disabled={busy}
        aria-busy={busy}
        onClick={() => void trading.enableQuickTrading(limits)}
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
        One signature in your wallet, then trades, TP/SL and cash-outs go through with one tap for{" "}
        {QUICK_DAYS} days.
      </p>
    </>
  );
}
