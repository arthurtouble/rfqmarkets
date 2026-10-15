// The Home screen's confirm step for a trade that isn't covered by one tap yet.
// It holds a firm price, refreshes it quietly when it lapses, and offers to
// turn on one tap so the next trade skips this step.
import { useCallback, useEffect, useMemo, useState } from "react";
import { useAccount } from "../account/useAccount.js";
import { useTrading } from "../data/actions.js";
import { useMarketFeed, useNow } from "../data/market-feed.js";
import { emptyAccount, estimateLiquidationPrice } from "../lib/account.js";
import { friendlyError } from "../lib/errors.js";
import { usdc, usdcCompact } from "../lib/format.js";
import { errorMessage } from "../lib/http.js";
import { leverageLabel, quoteUsable } from "../lib/ticket.js";
import type { Quote } from "../lib/types.js";
import { UP_DOWN, lossAt } from "../lib/updown.js";
import type { ReviewOrder } from "../trade/ReviewSheet.js";
import { Banner, Down, Rows, Sheet, Up, marketName } from "../ui/primitives.js";
import { useQuickLimits } from "../data/quick-limits.js";
import { QUICK_HOURS } from "../wallet/quick-session.js";

export function ConfirmSheet({
  order,
  onClose,
  onFilled,
}: {
  order: ReviewOrder;
  onClose: () => void;
  onFilled: () => void;
}) {
  const trading = useTrading(),
    quickLimits = useQuickLimits();
  const { snapshot } = useMarketFeed();
  const { account } = useAccount();
  const now = useNow(1_000);
  const offerOneTap = !trading.quickSession?.privateKey;
  const [oneTap, setOneTap] = useState(true);
  const [quote, setQuote] = useState<Quote | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const busy = trading.busy !== null;
  const { market, side, amountMicro, payMicro, leverage } = order;

  const refresh = useCallback(async () => {
    setProblem(null);
    try {
      setQuote(await trading.firmQuote(order));
    } catch (error) {
      setQuote(null);
      setProblem(friendlyError(errorMessage(error, "No price right now")));
    }
  }, [order]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    void refresh();
  }, [refresh]);
  const usable = !!quote && quoteUsable(quote.expiresAtMs, now);
  // A lapsed price is replaced without asking; the trader only ever sees a live one.
  useEffect(() => {
    if (quote && !usable && !busy) void refresh();
  }, [quote, usable, busy, refresh]);

  const autoClose = useMemo(() => {
    if (!snapshot) return null;
    // A Home trade holds only its amount as margin, so it auto-closes against that, not the whole balance.
    const base =
      order.isolated || !account
        ? { ...emptyAccount("", snapshot), collateral: payMicro.toString() }
        : account;
    return estimateLiquidationPrice(base, snapshot, market, side === "buy" ? amountMicro : -amountMicro);
  }, [account, snapshot, market, side, amountMicro, payMicro, order.isolated]);

  const confirm = async () => {
    if (!quote || !usable) return;
    if (!(await trading.marketOrder(order, quote))) {
      void refresh();
      return;
    }
    if (oneTap && offerOneTap) await trading.enableQuickTrading(quickLimits);
    onFilled();
  };

  const word = UP_DOWN[side];
  return (
    <Sheet open onClose={onClose} title={`${word} on ${marketName(market)}`} labelledBy="confirm-title">
      <div className="sheet-body">
        <p className="body review-sentence">
          <b className="tnum">{usdcCompact(payMicro)}</b> at <b className="tnum">{leverageLabel(leverage)}</b>
          , a <b className="tnum">{usdcCompact(amountMicro)}</b> position. If the price moves before you
          confirm, nothing happens.
        </p>
        <Rows
          rows={[
            ["Price", quote ? usdc(quote.expectedPrice) : "Getting a price…"],
            ["Auto-closes at", autoClose === null ? "—" : usdc(autoClose)],
          ]}
        />
        {autoClose !== null && quote && (
          <p className="footnote rfq-faint">
            If the price reaches {usdc(autoClose)}, the trade closes on its own and you lose about{" "}
            {usdcCompact(lossAt(amountMicro, BigInt(quote.expectedPrice), autoClose))}.
          </p>
        )}
        {problem && <Banner tone="warning">{problem}</Banner>}
        {offerOneTap && (
          <label className="check-row">
            <input type="checkbox" checked={oneTap} onChange={(event) => setOneTap(event.target.checked)} />
            <span>
              Skip this next time
              <span className="footnote rfq-faint">
                {" "}
                (up to {usdcCompact(quickLimits.maxTradeMicro)} a trade, for {QUICK_HOURS} hours)
              </span>
            </span>
          </label>
        )}
        <button
          type="button"
          className={`rfq-btn rfq-btn--lg rfq-btn--block rfq-btn--${side === "buy" ? "long" : "short"}`}
          disabled={!usable || busy}
          aria-busy={busy}
          onClick={() => void confirm()}
        >
          {busy ? (
            <>
              <span className="rfq-spinner" />
              Placing your trade…
            </>
          ) : (
            <>
              {side === "buy" ? <Up /> : <Down />} Confirm {word}
            </>
          )}
        </button>
      </div>
    </Sheet>
  );
}
