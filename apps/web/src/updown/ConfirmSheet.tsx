// The Home screen's confirm step for a trade that isn't covered by one tap yet.
// It holds a firm price, refreshes it quietly when it lapses (spaced out, and
// only a few times in a row before asking), and offers to turn on one tap so
// the next trade skips this step.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAccount } from "../account/useAccount.js";
import { useTrading } from "../data/actions.js";
import { useMarketFeed, useNow } from "../data/market-feed.js";
import { emptyAccount, estimateLiquidationPrice } from "../lib/account.js";
import { RequoteBackoff, type HeldQuote } from "../lib/clock.js";
import { friendlyError } from "../lib/errors.js";
import { usdPrice, usdcCompact } from "../lib/format.js";
import { errorMessage } from "../lib/http.js";
import { leverageLabel, quoteUsable } from "../lib/ticket.js";
import type { Quote } from "../lib/types.js";
import { UP_DOWN, lossAt } from "../lib/updown.js";
import type { ReviewOrder } from "../trade/ReviewSheet.js";
import { Banner, Down, Rows, Sheet, Up, marketName } from "../ui/primitives.js";
import { useQuickLimits } from "../data/quick-limits.js";
import { QUICK_DAYS } from "../wallet/quick-session.js";

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
  const [quote, setQuote] = useState<HeldQuote<Quote> | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [gaveUp, setGaveUp] = useState(false);
  const backoff = useRef(new RequoteBackoff());
  const inFlight = useRef(false);
  const busy = trading.busy !== null;
  const { market, side, amountMicro, payMicro, leverage } = order;

  const fetchQuote = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setLoading(true);
    setProblem(null);
    backoff.current.sent(Date.now());
    try {
      const fresh = await trading.firmQuote(order);
      // A price that lapsed on arrival counts as a failure, so a bad clock or a slow link backs off too.
      if (quoteUsable(fresh.localDeadlineMs, Date.now())) backoff.current.succeeded();
      else backoff.current.failed();
      setQuote(fresh);
    } catch (error) {
      backoff.current.failed();
      setQuote(null);
      setProblem(friendlyError(errorMessage(error, "No price right now")));
    } finally {
      inFlight.current = false;
      setLoading(false);
      setGaveUp(backoff.current.exhausted);
    }
  }, [order]); // eslint-disable-line react-hooks/exhaustive-deps
  const retry = useCallback(() => {
    backoff.current.reset();
    setGaveUp(false);
    void fetchQuote();
  }, [fetchQuote]);
  useEffect(retry, [retry]);
  const usable = !!quote && quoteUsable(quote.localDeadlineMs, now);
  // A lapsed or failed price is replaced without asking, spaced out; after a few misses in a row the sheet
  // offers Try again instead of asking the server over and over.
  const stale = !usable && (!!quote || !!problem);
  useEffect(() => {
    if (!stale || busy || loading || gaveUp) return;
    const wait = backoff.current.delay(Date.now());
    if (wait === null) {
      setGaveUp(true);
      return;
    }
    const timer = setTimeout(() => void fetchQuote(), wait);
    return () => clearTimeout(timer);
  }, [stale, busy, loading, gaveUp, fetchQuote]);

  const autoClose = useMemo(() => {
    if (!snapshot) return null;
    // A Home trade holds only its amount as margin, so it auto-closes against that, not the whole balance. Home
    // asks for at least MIN_ISOLATED_OPEN (lib/updown.ts stakeProblem), so every Home trade opens that way.
    const base =
      order.isolated || !account
        ? { ...emptyAccount("", snapshot), collateral: payMicro.toString() }
        : account;
    return estimateLiquidationPrice(base, snapshot, market, side === "buy" ? amountMicro : -amountMicro);
  }, [account, snapshot, market, side, amountMicro, payMicro, order.isolated]);

  const confirm = async () => {
    if (!quote || !usable) return;
    if (!(await trading.marketOrder(order, quote))) {
      retry();
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
          , a <b className="tnum">{usdcCompact(amountMicro)}</b> position. If the price moves too far before
          your trade fills, it's cancelled and you aren't charged.
        </p>
        <Rows
          rows={[
            ["Price", quote ? usdPrice(quote.expectedPrice) : problem || gaveUp ? "—" : "Getting a price…"],
            ["Auto-closes at", autoClose === null ? "—" : usdPrice(autoClose)],
          ]}
        />
        {autoClose !== null && quote && (
          <p className="footnote rfq-faint">
            If the price reaches {usdPrice(autoClose)}, the trade closes on its own and you lose about{" "}
            {usdcCompact(lossAt(amountMicro, BigInt(quote.expectedPrice), autoClose))}.
          </p>
        )}
        {problem ? (
          <Banner tone="warning">{problem}</Banner>
        ) : (
          gaveUp &&
          !usable && (
            <Banner tone="warning">We couldn't hold a price just now. Try again for a new one.</Banner>
          )
        )}
        {offerOneTap && (
          <label className="check-row">
            <input type="checkbox" checked={oneTap} onChange={(event) => setOneTap(event.target.checked)} />
            <span>
              Skip this next time
              <span className="footnote rfq-faint">
                {" "}
                (up to {usdcCompact(quickLimits.maxTradeMicro)} a trade, for {QUICK_DAYS} days)
              </span>
            </span>
          </label>
        )}
        {!usable && !busy && !loading && (problem || gaveUp) ? (
          <button
            type="button"
            className="rfq-btn rfq-btn--lg rfq-btn--block rfq-btn--secondary"
            onClick={retry}
          >
            Try again
          </button>
        ) : (
          <button
            type="button"
            className={`rfq-btn rfq-btn--lg rfq-btn--block rfq-btn--${side === "buy" ? "long" : "short"}`}
            disabled={!usable || busy}
            aria-busy={busy || (!usable && loading)}
            onClick={() => void confirm()}
          >
            {busy ? (
              <>
                <span className="rfq-spinner" />
                Placing your trade…
              </>
            ) : !usable ? (
              <>
                <span className="rfq-spinner" />
                Getting a price…
              </>
            ) : (
              <>
                {side === "buy" ? <Up /> : <Down />} Confirm {word}
              </>
            )}
          </button>
        )}
      </div>
    </Sheet>
  );
}
