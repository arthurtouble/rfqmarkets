// The home screen: one centred column with the market, a live tick chart and
// two buttons. Up opens a long, Down a short, at the chosen stake and
// multiplier; the bet stays open until the player cashes out. The order
// ticket and everything else live behind "Pro" (the /trade terminal).
import { useEffect, useMemo, useState } from "react";
import { Link } from "@tanstack/react-router";
import { useAccount } from "../account/useAccount.js";
import { useTrading } from "../data/actions.js";
import { useMarketFeed, useNow } from "../data/market-feed.js";
import { useMarketLeverage, useMarketList } from "../data/markets.js";
import { useTicks } from "../data/ticks.js";
import { initialMarginAfter } from "../lib/account.js";
import { parseUsdcInput, signedUsdc, usdc, usdcCompact } from "../lib/format.js";
import { DEFAULT_MARGIN_SCALE_BPS } from "../lib/leverage.js";
import { positionView, type PositionView } from "../lib/positions.js";
import { STALE_AFTER_MS, indicativeQuote } from "../lib/quote.js";
import { isDecimalDraft, leverageCeiling, leverageLabel, MARGIN_PROBLEM, ticketProblem } from "../lib/ticket.js";
import type { AccountState, Market, Side } from "../lib/types.js";
import {
  DEFAULT_MULTIPLIER,
  DEFAULT_STAKE,
  STAKE_PRESETS,
  betNotional,
  multiplierChoices,
  onePercentGain,
  pickMultiplier,
} from "../lib/updown.js";
import { Banner, Down, EmptyState, NavIcons, Segmented, Up, marketName } from "../ui/primitives.js";
import { useTrader } from "../wallet/trader.js";
import { WalletMenu } from "../wallet/WalletMenu.js";
import { useFunds } from "../trade/FundsDialog.js";
import { MarketSwitcher, PriceHeader } from "../trade/MarketHeader.js";
import { PriceChart } from "../trade/PriceChart.js";
import { ReviewSheet, type ReviewOrder } from "../trade/ReviewSheet.js";

const STAKE_KEY = "rfq.updown.stake",
  MULTIPLIER_KEY = "rfq.updown.multiplier",
  /** The stake behind the open bet in a market, so its return reads against what the player put in. */
  betStakeKey = (market: Market) => `rfq.updown.bet.${market}`;
const load = (key: string) => {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
};
const store = (key: string, value: string) => {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* private mode */
  }
};
const percent = (fraction: number | null) =>
  fraction === null ? "" : `${fraction > 0 ? "+" : ""}${(fraction * 100).toFixed(2)}%`;

export function UpDownPage({ market }: { market: Market }) {
  const list = useMarketList();
  if (!list.isLoading && !list.get(market))
    return (
      <div className="page">
        <section className="rfq-card">
          <EmptyState
            icon={NavIcons.markets}
            action={
              <Link className="rfq-btn rfq-btn--primary" to="/markets">
                See all markets
              </Link>
            }
          >
            <b>{market}</b> isn't listed on RFQ Markets.
          </EmptyState>
        </section>
      </div>
    );
  return <UpDown market={market} />;
}

function UpDown({ market }: { market: Market }) {
  const { account, error } = useAccount();
  const ticks = useTicks(market);
  const open = account ? positionView(account, market) : null;
  const reference = ticks.points[0] ? BigInt(Math.round(ticks.points[0].value * 1e6)).toString() : null;
  return (
    <div className="page updown">
      <div className="updown__top">
        <MarketSwitcher market={market} to="/updown/$market" />
        <Link className="rfq-btn rfq-btn--ghost rfq-btn--sm" to="/trade/$market" params={{ market }}>
          Pro
        </Link>
      </div>
      <PriceHeader market={market} reference={reference} period="5 min" />
      <PriceChart
        key={market}
        points={ticks.points}
        height={200}
        state={ticks.error ? "error" : ticks.loading ? "loading" : "ready"}
      />
      {error && <Banner tone="warning">We can't load your account right now. {error.message}</Banner>}
      {open ? <OpenBet view={open} /> : <NewBet market={market} account={account} />}
    </div>
  );
}

/** The bet in this market: live result and one button to cash out. */
function OpenBet({ view }: { view: PositionView }) {
  const trading = useTrading();
  const busy = trading.busy !== null;
  const tone = view.pnl > 0n ? "rfq-up" : view.pnl < 0n ? "rfq-down" : "rfq-faint";
  const stake = parseUsdcInput(load(betStakeKey(view.market)) ?? "");
  // Against the stake when this tab placed the bet; else against the margin the position uses.
  const ret = stake ? Number((view.pnl * 1_000_000n) / stake) / 1_000_000 : view.roe;
  return (
    <section className="updown-bet" aria-label="Your bet">
      <p className="updown-bet__what">
        You're <b className={view.long ? "rfq-up" : "rfq-down"}>{view.long ? "Up" : "Down"}</b> on{" "}
        {marketName(view.market)} with {usdcCompact(view.notional)}
      </p>
      <div className={`updown-bet__pnl tnum ${tone}`} aria-live="polite">
        <span>{signedUsdc(view.pnl)}</span>
        <span className="updown-bet__roe">{percent(ret)}</span>
      </div>
      <p className="footnote rfq-faint">
        Entry {usdc(view.entryPrice)}
        {view.liquidationPrice !== null && ` · Closes automatically at ${usdc(view.liquidationPrice)}`}
      </p>
      <button
        type="button"
        className="rfq-btn rfq-btn--lg rfq-btn--block rfq-btn--primary"
        disabled={busy}
        aria-busy={busy}
        onClick={() => void trading.closePosition(view.market)}
      >
        {busy ? (
          <>
            <span className="rfq-spinner" />
            Cashing out
          </>
        ) : (
          `Cash out ${signedUsdc(view.pnl)}`
        )}
      </button>
    </section>
  );
}

/** Stake, multiplier and the two buttons. */
function NewBet({ market, account }: { market: Market; account: AccountState | null }) {
  const { snapshot, status } = useMarketFeed();
  const trader = useTrader(),
    trading = useTrading(),
    funds = useFunds();
  const now = useNow(500);
  const leverageInfo = useMarketLeverage(market);
  const live = snapshot?.markets[market];
  const marketMax = leverageInfo?.maxLeverage ?? live?.maxLeverage ?? 20;
  const scaleBps = leverageInfo?.marginScaleBps ?? live?.marginScaleBps ?? DEFAULT_MARGIN_SCALE_BPS;
  const choices = multiplierChoices(marketMax);
  const [stake, setStake] = useState(() => load(STAKE_KEY) ?? String(DEFAULT_STAKE));
  const [chosen, setChosen] = useState(() => Number(load(MULTIPLIER_KEY)) || DEFAULT_MULTIPLIER);
  const [review, setReview] = useState<ReviewOrder | null>(null);
  const multiplier = pickMultiplier(chosen, choices);
  useEffect(() => setReview(null), [market]);

  const stakeMicro = parseUsdcInput(stake);
  const notional = stakeMicro ? betNotional(stakeMicro, multiplier) : 0n;
  const tradeCap = live ? BigInt(live.operatingMaxTradeNotional) : 0n;
  const fresh = status === "live" && !!live && now - live.observedAtMs <= STALE_AFTER_MS;
  const noFunds = !!account && BigInt(account.collateral) === 0n;
  const busy = trading.busy !== null;

  const problems = useMemo(() => {
    const check = (side: Side) => {
      const result = snapshot && notional > 0n ? indicativeQuote(snapshot, market, side, notional, now) : null;
      const quote = result && "quote" in result ? result.quote : null;
      const signed = side === "buy" ? notional : -notional;
      const marginAfter =
        account && snapshot && notional > 0n ? initialMarginAfter(account, snapshot, market, signed) : null;
      const fee = quote ? BigInt(quote.fee) : 0n;
      return ticketProblem({
        side,
        priceLive: fresh,
        enabled: live?.enabled ?? true,
        reduces: false,
        sideOpen: !live || (side === "buy" ? live.canBuy : live.canSell),
        amountText: stake,
        payMicro: stakeMicro,
        notionalMicro: notional,
        tradeCapMicro: tradeCap,
        leverage: multiplier,
        leverageCeiling: stakeMicro ? leverageCeiling(stakeMicro, marketMax, scaleBps) : marketMax,
        isLimit: false,
        limitMicro: null,
        quoteError: result && "error" in result ? result.error : null,
        hasQuote: !!quote,
        marginShort: !!account && marginAfter !== null && marginAfter + fee > BigInt(account.openingEquity),
      });
    };
    return { buy: check("buy"), sell: check("sell") };
  }, [snapshot, market, notional, now, account, fresh, live, stake, stakeMicro, tradeCap, multiplier, marketMax, scaleBps]);

  const chooseStake = (text: string) => {
    if (!isDecimalDraft(text)) return;
    setStake(text);
    store(STAKE_KEY, text);
  };
  const chooseMultiplier = (next: number) => {
    setChosen(next);
    store(MULTIPLIER_KEY, String(next));
  };
  const bet = async (side: Side) => {
    if (!stakeMicro || problems[side]) return;
    const order: ReviewOrder = {
      market,
      side,
      amountMicro: notional,
      payMicro: stakeMicro,
      leverage: multiplier,
      reduceOnly: false,
    };
    store(betStakeKey(market), stake);
    // One click once quick trading covers the size; otherwise the review sheet signs (and offers one-click).
    if (trading.quickCovers(market, notional)) await trading.marketOrder(order);
    else setReview(order);
  };

  // Why a button is off, once under both (no amount, no price) or for the one side that is closed.
  const reason = problems.buy ?? problems.sell;
  return (
    <section className="updown-new" aria-label="New bet">
      <div className="rfq-amount updown-stake">
        <label className="rfq-amount__field updown-stake__field">
          <span className="rfq-amount__prefix">$</span>
          <input
            inputMode="decimal"
            placeholder="0"
            autoComplete="off"
            aria-label="Stake in USDC"
            style={{ width: `${Math.max(1, stake.length) + 0.5}ch` }}
            value={stake}
            onChange={(event) => chooseStake(event.target.value)}
          />
        </label>
        <div className="rfq-chips" aria-label="Stake presets">
          {STAKE_PRESETS.map((step) => (
            <button
              key={step}
              type="button"
              className="rfq-chip"
              aria-pressed={stakeMicro === BigInt(step) * 1_000_000n}
              onClick={() => chooseStake(String(step))}
            >
              ${step}
            </button>
          ))}
        </div>
      </div>
      <Segmented
        label="Multiplier"
        value={String(multiplier)}
        onChange={(next) => chooseMultiplier(Number(next))}
        options={choices.map((step) => ({ id: String(step), label: leverageLabel(step) }))}
      />
      <p className="footnote rfq-muted center tnum" aria-live="polite">
        {notional > 0n
          ? `${usdcCompact(notional)} position. A 1% move your way: +${usdc(onePercentGain(notional))}`
          : "Pick a stake to see what a move is worth"}
      </p>

      {!trader.address ? (
        <WalletMenu className="rfq-btn--lg rfq-btn--block" connectLabel="Connect to play" />
      ) : noFunds || problems.buy === MARGIN_PROBLEM ? (
        <button
          type="button"
          className="rfq-btn rfq-btn--lg rfq-btn--primary rfq-btn--block"
          onClick={() => funds.open("deposit")}
        >
          Add money
        </button>
      ) : (
        <div className="updown-buttons">
          <button
            type="button"
            className="rfq-btn rfq-btn--lg rfq-btn--long updown-button"
            disabled={!!problems.buy || busy}
            aria-busy={busy}
            title={problems.buy ?? undefined}
            onClick={() => void bet("buy")}
          >
            <Up /> Up
          </button>
          <button
            type="button"
            className="rfq-btn rfq-btn--lg rfq-btn--short updown-button"
            disabled={!!problems.sell || busy}
            aria-busy={busy}
            title={problems.sell ?? undefined}
            onClick={() => void bet("sell")}
          >
            <Down /> Down
          </button>
        </div>
      )}
      {trader.address && !noFunds && reason && (
        <p className="footnote rfq-faint center" role="status">
          {reason}
        </p>
      )}
      {trader.address && !noFunds && !reason && trading.quickCovers(market, notional) && (
        <p className="footnote rfq-faint center">One tap, no wallet prompt.</p>
      )}
      {stakeMicro !== null && tradeCap > 0n && notional > tradeCap && (
        <p className="footnote rfq-faint center">
          Up to {usdc((tradeCap * 100n) / BigInt(Math.round(multiplier * 100)))} at {leverageLabel(multiplier)} per bet
        </p>
      )}

      {review && (
        <ReviewSheet order={review} onClose={() => setReview(null)} onDone={() => setReview(null)} />
      )}
    </section>
  );
}
