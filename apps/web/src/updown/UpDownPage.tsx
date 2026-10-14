// The home screen: one centred column with the market, a live tick chart and
// two buttons. Up opens a long, Down a short, at the chosen stake and
// multiplier; the bet stays open until the player cashes out. The order
// ticket and everything else live behind "Pro" (the /trade terminal). Any
// bet, open or cashed out, can be shared as an image card.
import { useEffect, useMemo, useState } from "react";
import { Link } from "@tanstack/react-router";
import { useAccount } from "../account/useAccount.js";
import { useTrading, type ClosedAt } from "../data/actions.js";
import { useMarketFeed, useNow } from "../data/market-feed.js";
import { useMarketLeverage, useMarketList } from "../data/markets.js";
import { useTicks } from "../data/ticks.js";
import { initialMarginAfter } from "../lib/account.js";
import { parseUsdcInput, signedUsdc, usdc, usdcCompact } from "../lib/format.js";
import { DEFAULT_MARGIN_SCALE_BPS } from "../lib/leverage.js";
import { closePreview, positionView, type PositionView } from "../lib/positions.js";
import { STALE_AFTER_MS, indicativeQuote } from "../lib/quote.js";
import type { ChartPoint } from "../lib/candles.js";
import { returnLabel, type ShareBet } from "../lib/share.js";
import {
  isDecimalDraft,
  leverageCeiling,
  leverageLabel,
  MARGIN_PROBLEM,
  ticketProblem,
} from "../lib/ticket.js";
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
import { ShareSheet } from "./ShareCard.js";

const STAKE_KEY = "rfq.updown.stake",
  MULTIPLIER_KEY = "rfq.updown.multiplier",
  /** The stake and multiplier behind the open bet in a market, so its return reads against what the player put in. */
  betKey = (market: Market) => `rfq.updown.bet.${market}`;
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
type BetRecord = { stake: bigint | null; multiplier: number | null };
/** The stored bet; older tabs stored the stake text alone. */
function loadBet(market: Market): BetRecord {
  const raw = load(betKey(market)) ?? "";
  try {
    const parsed = JSON.parse(raw) as { stake?: string; multiplier?: number };
    if (parsed && typeof parsed === "object")
      return { stake: parseUsdcInput(parsed.stake ?? ""), multiplier: Number(parsed.multiplier) || null };
  } catch {
    /* plain stake text */
  }
  return { stake: parseUsdcInput(raw), multiplier: null };
}
/** A bet as its share card shows it, from the position and (when closed) the fill it closed at. */
function shareBet(view: PositionView, closed: ClosedAt | null): ShareBet {
  const { stake, multiplier } = loadBet(view.market);
  const pnl = closed ? closePreview(view, 10_000, null, closed.price).realizedPnl - closed.fee : view.pnl;
  // Against the stake when this browser placed the bet; else against the margin the position uses.
  const ret = stake ? Number((pnl * 1_000_000n) / stake) / 1_000_000 : closed ? null : view.roe;
  return {
    market: view.market,
    name: marketName(view.market),
    long: view.long,
    multiplier,
    pnl,
    ret,
    entryPrice: view.entryPrice,
    price: closed ? closed.price : view.markPrice,
    closed: !!closed,
  };
}
type CashedOut = { bet: ShareBet; points: ChartPoint[] };

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
  const [cashedOut, setCashedOut] = useState<CashedOut | null>(null);
  const done = cashedOut?.bet.market === market ? cashedOut : null;
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
      {open ? (
        <OpenBet
          view={open}
          points={ticks.points}
          onCashedOut={(bet) => setCashedOut({ bet, points: ticks.points })}
        />
      ) : done ? (
        <CashOutResult result={done} onNext={() => setCashedOut(null)} />
      ) : (
        <NewBet market={market} account={account} />
      )}
    </div>
  );
}

const toneOf = (pnl: bigint) => (pnl > 0n ? "rfq-up" : pnl < 0n ? "rfq-down" : "rfq-faint");

/** The bet in this market: live result, one button to cash out and one to share. */
function OpenBet({
  view,
  points,
  onCashedOut,
}: {
  view: PositionView;
  points: ChartPoint[];
  onCashedOut: (bet: ShareBet) => void;
}) {
  const trading = useTrading();
  const busy = trading.busy !== null;
  const [sharing, setSharing] = useState<ShareBet | null>(null);
  const tone = toneOf(view.pnl);
  const bet = shareBet(view, null);
  const cashOut = async () => {
    // The position is gone once this resolves, so the result is worked out from the view captured here.
    const closed = await trading.closePosition(view.market);
    if (closed) onCashedOut(shareBet(view, closed));
  };
  return (
    <section className="updown-bet" aria-label="Your bet">
      <p className="updown-bet__what">
        You're <b className={view.long ? "rfq-up" : "rfq-down"}>{view.long ? "Up" : "Down"}</b> on{" "}
        {marketName(view.market)} with {usdcCompact(view.notional)}
      </p>
      <div className={`updown-bet__pnl tnum ${tone}`} aria-live="polite">
        <span>{signedUsdc(view.pnl)}</span>
        <span className="updown-bet__roe">{returnLabel(bet.ret)}</span>
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
        onClick={() => void cashOut()}
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
      <button type="button" className="rfq-btn rfq-btn--ghost rfq-btn--block" onClick={() => setSharing(bet)}>
        Share
      </button>
      {sharing && <ShareSheet bet={sharing} points={points} onClose={() => setSharing(null)} />}
    </section>
  );
}

/** What the last bet made, with a share button, until the player starts the next one. */
function CashOutResult({ result, onNext }: { result: CashedOut; onNext: () => void }) {
  const [sharing, setSharing] = useState(false);
  const { bet } = result;
  return (
    <section className="updown-bet" aria-label="Cashed out">
      <p className="updown-bet__what">
        You cashed out of <b className={bet.long ? "rfq-up" : "rfq-down"}>{bet.long ? "Up" : "Down"}</b> on{" "}
        {bet.name}
      </p>
      <div className={`updown-bet__pnl tnum ${toneOf(bet.pnl)}`}>
        <span>{signedUsdc(bet.pnl)}</span>
        <span className="updown-bet__roe">{returnLabel(bet.ret)}</span>
      </div>
      <p className="footnote rfq-faint">
        Entry {usdc(bet.entryPrice)} · Out at {usdc(bet.price)}
      </p>
      <button
        type="button"
        className="rfq-btn rfq-btn--lg rfq-btn--block rfq-btn--primary"
        onClick={() => setSharing(true)}
      >
        Share
      </button>
      <button type="button" className="rfq-btn rfq-btn--ghost rfq-btn--block" onClick={onNext}>
        New bet
      </button>
      {sharing && <ShareSheet bet={bet} points={result.points} onClose={() => setSharing(false)} />}
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
      const result =
        snapshot && notional > 0n ? indicativeQuote(snapshot, market, side, notional, now) : null;
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
  }, [
    snapshot,
    market,
    notional,
    now,
    account,
    fresh,
    live,
    stake,
    stakeMicro,
    tradeCap,
    multiplier,
    marketMax,
    scaleBps,
  ]);

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
    store(betKey(market), JSON.stringify({ stake, multiplier }));
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
          Up to {usdc((tradeCap * 100n) / BigInt(Math.round(multiplier * 100)))} at{" "}
          {leverageLabel(multiplier)} per bet
        </p>
      )}

      {review && (
        <ReviewSheet order={review} onClose={() => setReview(null)} onDone={() => setReview(null)} />
      )}
    </section>
  );
}
