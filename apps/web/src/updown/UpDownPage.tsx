// The home screen: one centred column with the market, a live tick chart and
// two buttons. Up opens a long, Down a short, at the chosen amount and
// multiplier; the trade stays open until the trader cashes out. The order
// ticket and everything else live behind "Pro" (the /trade terminal). Any
// trade, open or cashed out, can be shared as an image card.
import { useEffect, useMemo, useState } from "react";
import { Link } from "@tanstack/react-router";
import { useAccount, useAccountValue, useIsolatedAccount } from "../account/useAccount.js";
import { useTrading, type ClosedAt } from "../data/actions.js";
import { useMarketFeed, useServerNow } from "../data/market-feed.js";
import { useMarketLeverage, useMarketList } from "../data/markets.js";
import { useProtocol } from "../data/queries.js";
import { useQuickLimits } from "../data/quick-limits.js";
import { useTicks } from "../data/ticks.js";
import { initialMarginAfter } from "../lib/account.js";
import { abs, microToInput, parseUsdcInput, signedUsdc, usdc, usdcCompact, usdPrice } from "../lib/format.js";
import { DEFAULT_MARGIN_SCALE_BPS, marginFromLeverage } from "../lib/leverage.js";
import { closePreview, positionView, type PositionView } from "../lib/positions.js";
import { STALE_AFTER_MS, indicativeQuote } from "../lib/quote.js";
import type { ChartPoint } from "../lib/candles.js";
import { chartTime } from "../lib/market-stats.js";
import { returnLabel, type ShareBet } from "../lib/share.js";
import {
  isDecimalDraft,
  leverageCeiling,
  leverageLabel,
  MARGIN_PROBLEM,
  ticketProblem,
} from "../lib/ticket.js";
import type { AccountState, Market, Side } from "../lib/types.js";
import { IdleMargin } from "../positions/Positions.js";
import {
  DEFAULT_MULTIPLIER,
  DEFAULT_SIZE,
  SIZE_PRESETS,
  UP_DOWN,
  betRecordText,
  buyingPower,
  cashOutValue,
  feeWords,
  homeProblem,
  multiplierChoices,
  onePercentGain,
  parseBetRecord,
  pickMultiplier,
  recordMatches,
  type BetRecord,
  sizeProblem,
} from "../lib/updown.js";
import { load, store, forget } from "../lib/storage.js";
import { Banner, Down, InfoTip, Segmented, Up, marketName } from "../ui/primitives.js";
import { UnknownMarket } from "../markets/UnknownMarket.js";
import { useTrader } from "../wallet/trader.js";
import { WalletMenu } from "../wallet/WalletMenu.js";
import { useFunds } from "../trade/FundsDialog.js";
import { MarketSwitcher, PriceHeader } from "../trade/MarketHeader.js";
import { PriceChart } from "../trade/PriceChart.js";
import type { ReviewOrder } from "../trade/ReviewSheet.js";
import { ConfirmSheet } from "./ConfirmSheet.js";
import { StartTrading } from "../trade/StartTrading.js";
import { ShareSheet } from "./ShareCard.js";

// The amount box is the position size; the margin it holds is size over multiplier.
const SIZE_KEY = "rfq.updown.size",
  MULTIPLIER_KEY = "rfq.updown.multiplier",
  /** The amount and multiplier behind the open trade in a market, so its return reads against what went in. */
  betKey = (market: Market) => `rfq.updown.bet.${market}`;

/** Entry notional of a position, USDC 1e6. */
const entryNotional = (view: PositionView) => (view.size * view.entryPrice) / 10n ** 18n;
/** The stored record for the open position in a market, when this browser opened it. */
function recordFor(view: PositionView): BetRecord | null {
  const record = parseBetRecord(load(betKey(view.market)));
  return record && recordMatches(record, entryNotional(view)) ? record : null;
}
/** A trade as its share card shows it, from the position and (when closed) the fill it closed at. */
function shareBet(view: PositionView, record: BetRecord | null, closed: ClosedAt | null): ShareBet {
  const pnl = closed ? closePreview(view, 10_000, null, closed.price).realizedPnl - closed.fee : view.pnl;
  // Against the amount when this browser placed the trade; else against the margin the position uses.
  const stake = record?.stake ?? (closed && view.margin > 0n ? view.margin : undefined);
  const ret = stake ? Number((pnl * 1_000_000n) / stake) / 1_000_000 : view.roe;
  return {
    market: view.market,
    name: marketName(view.market),
    long: view.long,
    multiplier: record?.multiplier ?? null,
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
  if (!list.isLoading && !list.get(market)) return <UnknownMarket market={market} />;
  return <UpDown market={market} />;
}

function UpDown({ market }: { market: Market }) {
  const { account, loading, error } = useAccount();
  const trading = useTrading();
  const ticks = useTicks(market);
  // Home trades hold their own margin in the market's isolated account; one opened before that (or in Pro) is on
  // the main balance.
  const { account: isolatedAccount, loading: isolatedLoading } = useIsolatedAccount(market);
  const isolatedOpen = isolatedAccount ? positionView(isolatedAccount, market) : null;
  const open = isolatedOpen ?? (account ? positionView(account, market) : null);
  const reference = ticks.points[0] ? BigInt(Math.round(ticks.points[0].value * 1e6)).toString() : null;
  const [cashedOut, setCashedOut] = useState<CashedOut | null>(null);
  const [scrub, setScrub] = useState<ChartPoint | null>(null);
  const done = cashedOut?.bet.market === market ? cashedOut : null;
  const spanMs = ticks.points.length > 1 ? ticks.points.at(-1)!.time - ticks.points[0].time : 0;
  return (
    <div className="page updown">
      <div className="updown__top">
        <MarketSwitcher market={market} to="/updown/$market" />
        <div className="updown__end">
          <Balance />
          <Link className="rfq-btn rfq-btn--ghost rfq-btn--sm" to="/trade/$market" params={{ market }}>
            Pro
          </Link>
        </div>
      </div>
      <PriceHeader
        market={market}
        reference={reference}
        period="15 min"
        scrub={scrub && { value: scrub.value, label: chartTime(scrub.time, spanMs) }}
      />
      <PriceChart
        key={market}
        points={ticks.points}
        height={200}
        onScrub={setScrub}
        state={ticks.error ? "error" : ticks.loading ? "loading" : "ready"}
      />
      {error && <Banner tone="warning">We can't load your account. {error.message}</Banner>}
      {trading.busy === null && <IdleMargin />}
      {open ? (
        <OpenBet
          view={open}
          isolated={!!isolatedOpen}
          worth={
            isolatedOpen && isolatedAccount
              ? BigInt(isolatedAccount.equity)
              : (recordFor(open)?.stake ?? open.margin) + open.pnl + open.funding
          }
          points={ticks.points}
          onCashedOut={(bet) => setCashedOut({ bet, points: ticks.points })}
        />
      ) : done ? (
        <CashOutResult result={done} onNext={() => setCashedOut(null)} />
      ) : (
        <NewBet market={market} account={account} accountLoading={loading || isolatedLoading} />
      )}
    </div>
  );
}

/**
 * The account value (the balance plus open Home trades, the same number as the header and Portfolio), with Add
 * money and Withdraw one tap away. Phones have no top bar, so this is the way in. A dash until it has loaded.
 */
function Balance() {
  const funds = useFunds();
  const trader = useTrader();
  const { value, loading } = useAccountValue();
  const [open, setOpen] = useState(false);
  if (!trader.address || trader.wrongChain) return null;
  const pick = (mode: "deposit" | "withdraw") => {
    setOpen(false);
    funds.open(mode);
  };
  return (
    <div className="updown-balance">
      <button
        type="button"
        className="rfq-btn rfq-btn--ghost rfq-btn--sm tnum"
        aria-expanded={open}
        aria-label={value === null ? "Account value, loading" : `Account value ${usdc(value)}`}
        aria-busy={loading}
        onClick={() => setOpen((shown) => !shown)}
      >
        {value === null ? "—" : usdc(value)}
      </button>
      {open && (
        <div className="updown-balance__menu rfq-card">
          <button
            type="button"
            className="rfq-btn rfq-btn--primary rfq-btn--sm"
            onClick={() => pick("deposit")}
          >
            Add money
          </button>
          <button
            type="button"
            className="rfq-btn rfq-btn--ghost rfq-btn--sm"
            onClick={() => pick("withdraw")}
          >
            Withdraw
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * `value`, held until it moves by more than 0.2%: the liquidation estimate shifts by a few cents with every
 * quote's spread, which reads as a jumping number.
 */
function useSteady(value: bigint | null) {
  const [held, setHeld] = useState(value);
  useEffect(() => {
    if (value === null || held === null) setHeld(value);
    else if (abs(value - held) * 500n > held) setHeld(value);
  }, [value, held]);
  return value === null ? null : held;
}

const toneOf = (pnl: bigint) => (pnl > 0n ? "rfq-up" : pnl < 0n ? "rfq-down" : "rfq-faint");

/** The trade in this market: live result, one button to cash out and one to share. */
function OpenBet({
  view,
  isolated,
  worth,
  points,
  onCashedOut,
}: {
  view: PositionView;
  /** The trade holds its own margin, which returns to the balance on cash out. */
  isolated: boolean;
  /** What the trade is worth now: its isolated account's equity, or its amount plus PnL on the balance. */
  worth: bigint;
  points: ChartPoint[];
  onCashedOut: (bet: ShareBet) => void;
}) {
  const trading = useTrading();
  const { snapshot } = useMarketFeed();
  const paused = useProtocol().data?.paused ?? false;
  const busy = trading.busy !== null;
  // While trading is paused a trade on the main balance still closes at the oracle price (as Pro's close sheet
  // does); a Home trade on its own margin waits for trading to resume.
  const blocked = paused && isolated;
  const back = cashOutValue(worth, view.notional, paused ? 0 : (snapshot?.pricing.feeBps ?? 0));
  const [sharing, setSharing] = useState<ShareBet | null>(null);
  const tone = toneOf(view.pnl);
  const record = recordFor(view);
  const bet = shareBet(view, record, null);
  const stake = record?.stake ?? view.margin;
  const liquidation = useSteady(view.liquidationPrice);
  const cashOut = async () => {
    // The position is gone once this resolves, so the result is worked out from the view captured here.
    let closed: ClosedAt | undefined;
    if (paused) {
      const mid = snapshot?.markets[view.market]?.mid;
      if (blocked || !(await trading.emergencyClose(view.market))) return;
      closed = { price: mid ? BigInt(mid) : view.markPrice, fee: 0n };
    } else closed = await trading.closePosition(view.market, 10_000, isolated);
    if (!closed) return;
    forget(betKey(view.market));
    onCashedOut(shareBet(view, record, closed));
  };
  return (
    <section className="updown-bet" aria-label="Your trade">
      <p className="updown-bet__what">
        <b className={view.long ? "rfq-up" : "rfq-down"}>{view.long ? "Long" : "Short"}</b>{" "}
        {marketName(view.market)} · {usdcCompact(record?.notional ?? view.notional)}
        {record && ` at ${leverageLabel(record.multiplier)}`}
        <InfoTip label="About this trade">
          {usdc(stake)} of your money is in this trade, and that is the most it can lose. Cash out to get back
          what it is worth now. One trade per market here: pick another market above to open more, or use Pro
          to change this one.
        </InfoTip>
      </p>
      <div className={`updown-bet__pnl tnum ${tone}`}>
        <span>{signedUsdc(view.pnl)}</span>
        <span className="updown-bet__roe">{returnLabel(bet.ret)}</span>
      </div>
      <p className="footnote rfq-faint tnum updown-bet__details">
        <span>Entry {usdPrice(view.entryPrice)}</span>
        {liquidation !== null && (
          <span>
            Liquidation {usdPrice(liquidation)}
            <InfoTip label="About liquidation">
              If {marketName(view.market)} reaches this price the trade closes on its own and the{" "}
              {usdc(stake)} in it is lost. Funding moves it a little over time.
            </InfoTip>
          </span>
        )}
      </p>
      {blocked ? (
        <Banner tone="warning">
          <b>Trading is paused.</b> You can cash out this trade once trading resumes.
        </Banner>
      ) : (
        paused && (
          <Banner tone="warning">
            <b>Trading is paused.</b> You can still cash out at the oracle price.
          </Banner>
        )
      )}
      <button
        type="button"
        className="rfq-btn rfq-btn--lg rfq-btn--block rfq-btn--primary"
        disabled={busy || blocked}
        aria-busy={busy}
        onClick={() => void cashOut()}
      >
        {busy ? (
          <>
            <span className="rfq-spinner" />
            Cashing out
          </>
        ) : (
          // What comes back to the balance, not the PnL (which reads like a fee when negative).
          `Cash out ${usdc(back)}`
        )}
      </button>
      <button type="button" className="rfq-btn rfq-btn--ghost rfq-btn--block" onClick={() => setSharing(bet)}>
        Share
      </button>
      {sharing && <ShareSheet bet={sharing} points={points} onClose={() => setSharing(null)} />}
    </section>
  );
}

/** What the last trade made, with a share button, until the trader starts the next one. */
function CashOutResult({ result, onNext }: { result: CashedOut; onNext: () => void }) {
  const [sharing, setSharing] = useState(false);
  const { bet } = result;
  return (
    <section className="updown-bet" aria-label="Cashed out">
      <p className="updown-bet__what">
        You cashed out of <b className={bet.long ? "rfq-up" : "rfq-down"}>{bet.long ? "Long" : "Short"}</b>{" "}
        {bet.name}
      </p>
      <div className={`updown-bet__pnl tnum ${toneOf(bet.pnl)}`}>
        <span>{signedUsdc(bet.pnl)}</span>
        <span className="updown-bet__roe">{returnLabel(bet.ret)}</span>
      </div>
      <p className="footnote rfq-faint">
        Entry {usdPrice(bet.entryPrice)} · Out at {usdPrice(bet.price)}
      </p>
      <button
        type="button"
        className="rfq-btn rfq-btn--lg rfq-btn--block rfq-btn--primary"
        onClick={() => setSharing(true)}
      >
        Share
      </button>
      <button type="button" className="rfq-btn rfq-btn--ghost rfq-btn--block" onClick={onNext}>
        New trade
      </button>
      {sharing && <ShareSheet bet={bet} points={result.points} onClose={() => setSharing(false)} />}
    </section>
  );
}

/** Amount, multiplier and the two buttons. */
function NewBet({
  market,
  account,
  accountLoading,
}: {
  market: Market;
  account: AccountState | null;
  accountLoading: boolean;
}) {
  const { snapshot, status } = useMarketFeed();
  const trader = useTrader(),
    trading = useTrading(),
    quickLimits = useQuickLimits(),
    funds = useFunds();
  const now = useServerNow(1_000);
  const leverageInfo = useMarketLeverage(market);
  const live = snapshot?.markets[market];
  const marketMax = leverageInfo?.maxLeverage ?? live?.maxLeverage ?? 20;
  const scaleBps = leverageInfo?.marginScaleBps ?? live?.marginScaleBps ?? DEFAULT_MARGIN_SCALE_BPS;
  const choices = multiplierChoices(marketMax);
  const [size, setSize] = useState(() => load(SIZE_KEY) ?? String(DEFAULT_SIZE));
  const [chosen, setChosen] = useState(() => Number(load(MULTIPLIER_KEY)) || DEFAULT_MULTIPLIER);
  const [review, setReview] = useState<ReviewOrder | null>(null);
  const multiplier = pickMultiplier(chosen, choices);
  useEffect(() => setReview(null), [market]);

  const sizeMicro = parseUsdcInput(size);
  const notional = sizeMicro ?? 0n;
  const stakeMicro = sizeMicro ? marginFromLeverage(sizeMicro, multiplier) : null;
  const tradeCap = live ? BigInt(live.operatingMaxTradeNotional) : 0n;
  const fresh = status === "live" && !!live && now - live.observedAtMs <= STALE_AFTER_MS;
  // Until the account has loaded its balance reads as zero; that is not "no money".
  const ready = !!account && !accountLoading;
  const noFunds = ready && BigInt(account.collateral) === 0n;
  const busy = trading.busy !== null;

  const problems = useMemo(() => {
    const check = (side: Side) => {
      const result =
        snapshot && notional > 0n ? indicativeQuote(snapshot, market, side, notional, now) : null;
      const quote = result && "quote" in result ? result.quote : null;
      const signed = side === "buy" ? notional : -notional;
      const marginAfter =
        ready && snapshot && notional > 0n ? initialMarginAfter(account, snapshot, market, signed) : null;
      const problem = ticketProblem({
        side,
        priceLive: fresh,
        enabled: live?.enabled ?? true,
        reduces: false,
        sideOpen: !live || (side === "buy" ? live.canBuy : live.canSell),
        amountText: size,
        payMicro: stakeMicro,
        notionalMicro: notional,
        tradeCapMicro: tradeCap,
        leverage: multiplier,
        leverageCeiling: stakeMicro ? leverageCeiling(stakeMicro, marketMax, scaleBps) : marketMax,
        isLimit: false,
        limitMicro: null,
        quoteError: result && "error" in result ? result.error : null,
        hasQuote: !!quote,
        // Simple trades are isolated: their margin moves out of the free balance, so it must cover the stake.
        marginShort:
          ready &&
          ((stakeMicro !== null && stakeMicro > BigInt(account.availableMargin)) ||
            (marginAfter !== null && marginAfter > BigInt(account.openingEquity))),
      });
      return sizeProblem(sizeMicro) ?? homeProblem(problem, side, { tradeCapMicro: tradeCap });
    };
    return { buy: check("buy"), sell: check("sell") };
  }, [
    snapshot,
    market,
    notional,
    now,
    account,
    ready,
    fresh,
    live,
    size,
    stakeMicro,
    tradeCap,
    multiplier,
    marketMax,
    scaleBps,
  ]);

  const chooseSize = (text: string) => {
    if (!isDecimalDraft(text)) return;
    setSize(text);
    store(SIZE_KEY, text);
  };
  const power = ready ? buyingPower(BigInt(account.availableMargin), multiplier, tradeCap) : null;
  const chooseMultiplier = (next: number) => {
    setChosen(next);
    store(MULTIPLIER_KEY, String(next));
  };
  // Remembered only once the trade fills, so a cancelled one leaves nothing behind.
  const remember = (order: ReviewOrder) =>
    store(
      betKey(order.market),
      betRecordText({ stake: order.payMicro, multiplier: order.leverage, notional: order.amountMicro }),
    );
  const trade = async (side: Side) => {
    if (!stakeMicro || problems[side]) return;
    const word = UP_DOWN[side];
    const order: ReviewOrder = {
      market,
      side,
      amountMicro: notional,
      payMicro: stakeMicro,
      leverage: multiplier,
      reduceOnly: false,
      title: `${word} ${marketName(market)} · ${usdcCompact(notional)} at ${leverageLabel(multiplier)}`,
      isolated: { payMicro: stakeMicro },
    };
    // One tap: the first trade in this browser grants a week's one-tap key (one wallet signature). Only a
    // size past the key's limits goes through the confirm step and the wallet.
    if (await trading.readyQuick(market, notional, quickLimits)) {
      if (await trading.marketOrder(order)) remember(order);
    } else if (notional > quickLimits.maxTradeMicro) setReview(order);
  };

  // Why a button is off, once under both (no amount, no price) or for the one side that is closed.
  const reason = problems.buy ?? problems.sell;
  const waiting = !!trader.address && !ready;
  return (
    <section className="updown-new" aria-label="New trade">
      <div className="rfq-amount updown-stake">
        <label className="rfq-amount__field updown-stake__field">
          <span className="rfq-amount__prefix">$</span>
          <input
            inputMode="decimal"
            placeholder="0"
            autoComplete="off"
            aria-label="Position size in USDC"
            style={{ width: `${Math.max(1, size.length) + 0.5}ch` }}
            value={size}
            onChange={(event) => chooseSize(event.target.value)}
          />
        </label>
        <div className="rfq-chips" aria-label="Size presets">
          {SIZE_PRESETS.map((step) => (
            <button
              key={step}
              type="button"
              className="rfq-chip"
              aria-pressed={sizeMicro === BigInt(step) * 1_000_000n}
              onClick={() => chooseSize(String(step))}
            >
              ${step}
            </button>
          ))}
          {power !== null && power > 0n && (
            <button
              type="button"
              className="rfq-chip"
              aria-pressed={sizeMicro === power - (power % 10_000n)}
              onClick={() => chooseSize(microToInput(power - (power % 10_000n)))}
            >
              Max
            </button>
          )}
        </div>
      </div>
      <Segmented
        label="Multiplier"
        value={String(multiplier)}
        onChange={(next) => chooseMultiplier(Number(next))}
        options={choices.map((step) => ({ id: String(step), label: leverageLabel(step) }))}
      />
      <p className="footnote rfq-muted center tnum updown-bet__details">
        <span>Margin {notional > 0n && stakeMicro ? usdc(stakeMicro) : "—"}</span>
        {power !== null && <span>Buying power {usdc(power)}</span>}
        {notional > 0n && (
          <InfoTip label="About this trade">
            Margin is the money this trade uses: the size divided by the multiplier, and the most it can lose.
            Buying power is the biggest trade your balance allows at {leverageLabel(multiplier)}. This one has{" "}
            {feeWords(notional, snapshot?.pricing.feeBps ?? 0)}; a 1% move your way makes about{" "}
            {usdc(onePercentGain(notional))}.
          </InfoTip>
        )}
      </p>

      {!trader.address ? (
        <WalletMenu className="rfq-btn--lg rfq-btn--block" connectLabel="Connect to trade" />
      ) : noFunds ? (
        <button
          type="button"
          className="rfq-btn rfq-btn--lg rfq-btn--primary rfq-btn--block"
          onClick={() => funds.open("deposit")}
        >
          Add money
        </button>
      ) : ready && !trading.quickLive ? (
        <StartTrading />
      ) : problems.buy === MARGIN_PROBLEM ? (
        <button
          type="button"
          className="rfq-btn rfq-btn--lg rfq-btn--primary rfq-btn--block"
          onClick={() => funds.open("deposit")}
        >
          Add money
        </button>
      ) : (
        <div className="updown-buttons">
          {(["buy", "sell"] as const).map((side) => (
            <button
              key={side}
              type="button"
              className={`rfq-btn rfq-btn--lg rfq-btn--${side === "buy" ? "long" : "short"} updown-button`}
              disabled={waiting || !!problems[side] || busy}
              aria-busy={busy}
              aria-describedby={reason ? "updown-reason" : undefined}
              onClick={() => void trade(side)}
            >
              {side === "buy" ? <Up /> : <Down />} {UP_DOWN[side]}
            </button>
          ))}
        </div>
      )}
      {trader.address && !noFunds && (!ready || trading.quickLive) && (waiting || reason) && (
        <p id="updown-reason" className="footnote rfq-muted center" role="status">
          {waiting ? "Loading your balance" : reason}
        </p>
      )}

      {review && (
        <ConfirmSheet
          order={review}
          onClose={() => setReview(null)}
          onFilled={() => {
            remember(review);
            setReview(null);
          }}
        />
      )}
    </section>
  );
}
