import { useCallback, useEffect, useMemo, useState } from "react";
import { useTrading, type MarketOrder } from "../data/actions.js";
import { useMarketFeed, useNow } from "../data/market-feed.js";
import { emptyAccount, estimateLiquidationPrice } from "../lib/account.js";
import type { HeldQuote } from "../lib/clock.js";
import { useAccount } from "../account/useAccount.js";
import { abs, baseAmount, usdc, usdcCompact, usdPrice } from "../lib/format.js";
import { friendlyError } from "../lib/errors.js";
import { errorMessage } from "../lib/http.js";
import { leverageLabel, quoteSecondsLeft, quoteUsable, SIDE_WORD } from "../lib/ticket.js";
import type { Quote } from "../lib/types.js";
import { Banner, Rows, marketName, Sheet } from "../ui/primitives.js";
import { useQuickLimits } from "../data/quick-limits.js";
import { QUICK_HOURS } from "../wallet/quick-session.js";

/** A market order as the ticket built it: the position (`amountMicro`) and what the trader pays for it. */
export type ReviewOrder = MarketOrder & { payMicro: bigint; leverage: number };

/**
 * Restates a market order in plain words at a firm quote before the wallet
 * signature. The quote is fetched when the sheet opens and can be refreshed
 * once it lapses; the trade signs exactly that quote.
 */
export function ReviewSheet({
  order,
  onClose,
  onDone,
}: {
  order: ReviewOrder;
  onClose: () => void;
  onDone: () => void;
}) {
  const trading = useTrading(),
    quickLimits = useQuickLimits();
  const { snapshot } = useMarketFeed();
  const { account } = useAccount();
  const now = useNow(250);
  const offerOneClick = !trading.quickSession?.privateKey;
  const [oneClick, setOneClick] = useState(offerOneClick);
  const [quote, setQuote] = useState<HeldQuote<Quote> | null>(null);
  const [quoteError, setQuoteError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const busy = trading.busy !== null;
  const { market, side, amountMicro, payMicro, leverage } = order;

  const refresh = useCallback(async () => {
    setLoading(true);
    setQuoteError(null);
    try {
      setQuote(await trading.firmQuote(order));
    } catch (error) {
      setQuote(null);
      setQuoteError(friendlyError(errorMessage(error, "No quote right now")));
    } finally {
      setLoading(false);
    }
  }, [order]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Judged on this device's clock from when the quote arrived, so a fast or slow clock can't expire it early.
  const usable = !!quote && quoteUsable(quote.localDeadlineMs, now);
  const secondsLeft = quote ? quoteSecondsLeft(quote.localDeadlineMs, now) : 0;
  const liquidation = useMemo(() => {
    if (!snapshot) return null;
    const base = account ?? { ...emptyAccount("", snapshot), collateral: payMicro.toString() };
    return estimateLiquidationPrice(base, snapshot, market, side === "buy" ? amountMicro : -amountMicro);
  }, [account, snapshot, market, side, amountMicro, payMicro]);

  const confirm = async () => {
    if (!quote || !usable) return;
    const filled = await trading.marketOrder(order, quote);
    if (!filled) {
      void refresh();
      return;
    }
    if (oneClick && offerOneClick) await trading.enableQuickTrading(quickLimits);
    onDone();
  };

  const word = SIDE_WORD[side];
  const base = quote?.baseDelta ? `${baseAmount(abs(BigInt(quote.baseDelta)))} ${market}` : market;
  return (
    <Sheet open onClose={onClose} title="Review order" labelledBy="review-title">
      <div className="sheet-body">
        <p className="body review-sentence">
          {word} <b className="tnum">{base}</b> on {marketName(market)} at{" "}
          <b className="tnum">{leverageLabel(leverage)}</b>, paying{" "}
          <b className="tnum">{usdcCompact(payMicro)}</b>. If the price moves past your protection before your
          order fills, it's cancelled and you aren't charged.
        </p>
        <Rows
          rows={[
            ["Entry price", loading && !quote ? "Getting a firm price…" : usdPrice(quote?.expectedPrice)],
            [
              side === "buy" ? "Price protection (max)" : "Price protection (min)",
              usdPrice(quote?.worstPrice),
            ],
            ["Liquidation price", liquidation === null ? "—" : usdPrice(liquidation)],
            ["Margin", usdc(payMicro)],
            ["Position size", usdc(amountMicro), "is-total"],
          ]}
        />
        {quoteError && <Banner tone="warning">{quoteError}</Banner>}
        {offerOneClick && (
          <label className="check-row">
            <input
              type="checkbox"
              checked={oneClick}
              onChange={(event) => setOneClick(event.target.checked)}
            />
            <span>
              Skip this step next time
              <span className="footnote rfq-faint">
                {" "}
                · trades up to {usdcCompact(quickLimits.maxTradeMicro)} sign in this tab for {QUICK_HOURS}{" "}
                hours (one more signature now)
              </span>
            </span>
          </label>
        )}
        {usable || busy ? (
          <button
            type="button"
            className={`rfq-btn rfq-btn--lg rfq-btn--block rfq-btn--${side === "buy" ? "long" : "short"}`}
            disabled={busy}
            aria-busy={busy}
            onClick={() => void confirm()}
          >
            {busy ? (
              <>
                <span className="rfq-spinner" />
                Confirm in your wallet
              </>
            ) : (
              "Confirm and sign"
            )}
          </button>
        ) : (
          <button
            type="button"
            className="rfq-btn rfq-btn--lg rfq-btn--block rfq-btn--secondary"
            disabled={loading}
            aria-busy={loading}
            onClick={() => void refresh()}
          >
            {loading ? (
              <>
                <span className="rfq-spinner" />
                Getting a firm price
              </>
            ) : (
              "Refresh quote"
            )}
          </button>
        )}
        <p className="footnote rfq-faint sheet-note center" aria-live="polite">
          {usable
            ? `Price held for ${secondsLeft}s. No gas needed.`
            : quote
              ? "This price expired. Refresh for a new one."
              : "No gas needed."}
        </p>
      </div>
    </Sheet>
  );
}
