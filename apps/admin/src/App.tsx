import React from "react";
import { useHedgeFeed, useNow, useRiskFeed } from "./feeds.js";
import { base, clockTime, integer, percent, price, shortId, signedBase, usd } from "./format.js";
import {
  MODE_LABEL,
  STATE_LABEL,
  attention,
  duration,
  feedHealth,
  marketViews,
  totalGap,
  type FeedHealth,
  type HedgeOrder,
  type MarketView,
  type Tone,
} from "./model.js";

const toneBadge: Record<Tone, string> = {
  ok: "rfq-badge--long",
  warn: "rfq-badge--warning",
  bad: "rfq-badge--short",
  idle: "",
};

export function App() {
  const hedgeFeed = useHedgeFeed(),
    { risk, error: riskError } = useRiskFeed(),
    now = useNow(),
    hedge = hedgeFeed.status,
    health = feedHealth(hedge, hedgeFeed, now),
    markets = marketViews(risk, hedge),
    needs = attention(hedge),
    gap = hedge ? totalGap(hedge) : undefined,
    // Without data and with a failed read, show dashes instead of loading placeholders.
    hedgeFailed = !hedge && Boolean(hedgeFeed.error),
    riskFailed = !risk && Boolean(riskError);
  return (
    <>
      <header className="rfq-topbar ops-topbar">
        <span className="rfq-logo">
          <Mark />
          RFQ Markets
        </span>
        <span className="ops-tag">Operations</span>
        <div className="rfq-topbar__end">
          <HealthPill health={health} />
        </div>
      </header>
      <main className="ops-page">
        <div className="ops-heading">
          <div>
            <h1 className="title-1">Hedge operations</h1>
            <p className="rfq-muted">Finalized customer exposure on Base against the hedge venue position.</p>
          </div>
          <p className="ops-updated rfq-faint" aria-live="polite">
            {hedge?.observedAtMs ? `Updated ${duration(now - hedge.observedAtMs)} ago` : ""}
          </p>
        </div>

        {health.detail && health.tone !== "ok" && (
          <div className={`rfq-banner ${health.tone === "warn" ? "rfq-banner--warning" : "rfq-banner--danger"}`} role="status">
            <span>
              <b>Hedger {health.label.toLowerCase()}.</b> {health.detail}
            </span>
          </div>
        )}
        {riskError && (
          <div className="rfq-banner rfq-banner--danger" role="status">
            <span>
              <b>Exposure unavailable.</b> {riskError}
            </span>
          </div>
        )}

        <section className="ops-summary" aria-label="Summary">
          <Stat label="Customer collateral" value={risk ? usd(risk.totalCollateral) : undefined} failed={riskFailed}>
            {risk ? `${integer(risk.accountCount)} funded ${plural(risk.accountCount, "account")}` : riskFailed ? "Unavailable" : "Loading"}
          </Stat>
          <Stat label="Unhedged gap" value={gap === undefined ? undefined : usd(gap)} failed={hedgeFailed}>
            {!hedge
              ? hedgeFailed
                ? "Unavailable"
                : "Loading"
              : needs.hedgeRequired
                ? `${needs.hedgeRequired} ${needs.hedgeRequired === 1 ? "market needs" : "markets need"} a hedge`
                : "All markets inside their band"}
          </Stat>
          <Stat label="Hedge venue" value={hedge?.mode} failed={hedgeFailed}>
            {needs.unhedged ? `${needs.unhedged} ${needs.unhedged === 1 ? "market has" : "markets have"} no venue` : "Separate capital account"}
          </Stat>
          <Stat label="Hedger block" value={hedge ? integer(hedge.indexedBlock) : undefined} failed={hedgeFailed}>
            Indexer at {risk ? integer(risk.indexedBlock) : "—"}
          </Stat>
        </section>

        <section className="ops-section" aria-labelledby="markets-title">
          <div className="ops-section__head">
            <h2 id="markets-title" className="headline">Markets</h2>
            {needs.restricted > 0 && (
              <span className="rfq-badge rfq-badge--warning">
                {needs.restricted} restricted for trading
              </span>
            )}
          </div>
          {markets.length ? (
            <div className="ops-markets">
              {markets.map((market) => (
                <MarketCard key={market.symbol} market={market} />
              ))}
            </div>
          ) : hedgeFailed && riskFailed ? (
            <div className="rfq-card rfq-empty">
              <p>Markets appear once the hedger or the indexer answers.</p>
            </div>
          ) : (
            <div className="rfq-card ops-skeleton-grid" aria-busy="true">
              <div className="rfq-skel" />
              <div className="rfq-skel" />
            </div>
          )}
        </section>

        <section className="ops-section" aria-labelledby="orders-title">
          <div className="ops-section__head">
            <h2 id="orders-title" className="headline">Recent hedge orders</h2>
            <span className="rfq-faint footnote">Last 20 · stable client IDs · marketable limits</span>
          </div>
          <Orders orders={hedge?.orders} failed={hedgeFailed} />
        </section>

        <footer className="ops-footer rfq-faint">
          Read-only. This page holds no keys and cannot place, cancel or change anything.
        </footer>
      </main>
    </>
  );
}

function Mark() {
  return (
    <svg width="24" height="24" viewBox="0 0 32 32" aria-hidden="true">
      <rect width="32" height="32" rx="8" fill="var(--brand)" />
      <path d="M9 22V10h4.5v4.5h5V10H23v12h-4.5v-4.5h-5V22z" fill="var(--on-brand)" />
    </svg>
  );
}

export function HealthPill({ health }: { health: FeedHealth }) {
  return (
    <span className={`rfq-badge ops-health ${toneBadge[health.tone]}`} data-tone={health.tone} title={health.detail}>
      <i className="rfq-dot" />
      {health.label}
    </span>
  );
}

const plural = (count: number | undefined, noun: string) => (count === 1 ? noun : `${noun}s`);

export function Stat({
  label,
  value,
  failed,
  children,
}: {
  label: string;
  value?: string;
  failed?: boolean;
  children: React.ReactNode;
}) {
  return (
    <article className="rfq-card rfq-card--pad ops-stat">
      <span className="caption rfq-muted">{label}</span>
      {value === undefined && !failed ? (
        <span className="rfq-skel ops-stat__skel" />
      ) : (
        <strong className="title-2 tnum">{value ?? "—"}</strong>
      )}
      <span className="footnote rfq-faint">{children}</span>
    </article>
  );
}

function Coin({ symbol }: { symbol: string }) {
  const known = ["BTC", "ETH"].includes(symbol);
  return (
    <span className={`rfq-coin ${known ? `rfq-coin--${symbol.toLowerCase()}` : "ops-coin"}`} aria-hidden="true">
      {symbol.slice(0, 1)}
    </span>
  );
}

export function MarketCard({ market }: { market: MarketView }) {
  const { symbol, risk, hedge, longShare, bandUse } = market;
  const stateTone =
    hedge?.state === "within_band" ? "rfq-badge--long" : hedge?.state === "hedge_required" ? "rfq-badge--short" : "rfq-badge--warning";
  const modeTone = hedge?.tradingMode === "normal" ? "" : hedge?.tradingMode === "guarded" ? "rfq-badge--warning" : "rfq-badge--short";
  return (
    <article className="rfq-card rfq-card--pad ops-market" aria-label={`${symbol} market`}>
      <div className="ops-market__head">
        <Coin symbol={symbol} />
        <div>
          <b className="headline">{symbol}</b>
          <span className="caption rfq-faint">
            {" "}
            Perp{hedge?.coin && hedge.coin !== symbol ? ` · hedged as ${hedge.coin}` : ""}
          </span>
        </div>
        <div className="ops-market__badges">
          {hedge?.tradingMode && <span className={`rfq-badge ${modeTone}`}>{MODE_LABEL[hedge.tradingMode]}</span>}
          {hedge && <span className={`rfq-badge ${stateTone}`}>{STATE_LABEL[hedge.state]}</span>}
        </div>
      </div>

      <div className="ops-split">
        <div>
          <span className="caption rfq-muted">Customer longs</span>
          <strong className="num rfq-up">
            {base(risk?.longBase)} {symbol}
          </strong>
          <span className="caption rfq-faint">{integer(risk?.longAccounts)} {plural(risk?.longAccounts, "account")}</span>
        </div>
        <div className="ops-split__end">
          <span className="caption rfq-muted">Customer shorts</span>
          <strong className="num rfq-down">
            {base(risk?.shortBase)} {symbol}
          </strong>
          <span className="caption rfq-faint">{integer(risk?.shortAccounts)} {plural(risk?.shortAccounts, "account")}</span>
        </div>
      </div>
      <div
        className="ops-bar"
        role="img"
        aria-label={longShare === undefined ? "No open customer exposure" : `${percent(longShare)} of customer exposure is long`}
      >
        {longShare === undefined ? <i className="ops-bar__empty" /> : <i className="ops-bar__long" style={{ width: `${longShare}%` }} />}
      </div>

      <dl className="rfq-dl ops-dl">
        <div>
          <dt>Net customer</dt>
          <dd>
            {signedBase(risk?.netBase ?? hedge?.customerBase)} {symbol}
          </dd>
        </div>
        <div>
          <dt>Venue hedge</dt>
          <dd>
            {signedBase(hedge?.venueBase)} {symbol}
          </dd>
        </div>
        <div>
          <dt>Unhedged gap</dt>
          <dd>
            {signedBase(hedge?.gapBase)} {symbol}
          </dd>
        </div>
        <div className="is-total">
          <dt>Gap notional</dt>
          <dd>
            {usd(hedge?.gapNotional)} <span className="rfq-faint">of {usd(hedge?.bandUsdc)} band</span>
          </dd>
        </div>
      </dl>
      {bandUse !== undefined && (
        <div
          className="ops-meter"
          role="meter"
          aria-label="Gap as a share of the action band"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.min(100, Math.round(bandUse))}
          data-over={bandUse > 100 || undefined}
        >
          <i style={{ width: `${Math.min(100, Math.max(bandUse, bandUse > 0 ? 2 : 0))}%` }} />
        </div>
      )}
      {hedge?.executionError && (
        <p className="rfq-banner rfq-banner--warning footnote">Venue execution check failed: {hedge.executionError}</p>
      )}
    </article>
  );
}

const orderTone = (status: string) =>
  status === "filled" ? "rfq-badge--long" : status === "rejected" ? "rfq-badge--short" : "rfq-badge--warning";
const statusLabel = (status: string) => status[0].toUpperCase() + status.slice(1);
const side = (order: HedgeOrder) => (BigInt(order.base_delta) >= 0n ? "Long" : "Short");
const size = (order: HedgeOrder) => base(BigInt(order.base_delta) < 0n ? -BigInt(order.base_delta) : BigInt(order.base_delta));
const filled = (order: HedgeOrder) =>
  order.filled_base === undefined ? "—" : base(BigInt(order.filled_base) < 0n ? -BigInt(order.filled_base) : BigInt(order.filled_base));

export function Orders({ orders, failed }: { orders?: HedgeOrder[]; failed?: boolean }) {
  if (!orders && failed)
    return (
      <div className="rfq-card rfq-empty">
        <p>Hedge orders appear once the hedger answers.</p>
      </div>
    );
  if (!orders)
    return (
      <div className="rfq-card ops-skeleton-list" aria-busy="true">
        <div className="rfq-skel" />
        <div className="rfq-skel" />
      </div>
    );
  if (!orders.length)
    return (
      <div className="rfq-card rfq-empty">
        <p>No hedge orders yet. The hedger places one when a market's gap leaves its action band.</p>
      </div>
    );
  return (
    <div className="rfq-card ops-orders">
      <div className="rfq-table-wrap ops-orders__table">
        <table className="rfq-table">
          <thead>
            <tr>
              <th>Time</th>
              <th>Market</th>
              <th>Side</th>
              <th>Size</th>
              <th>Filled</th>
              <th>Limit</th>
              <th>Status</th>
              <th>Block</th>
            </tr>
          </thead>
          <tbody>
            {orders.map((order) => (
              <tr key={order.client_id} title={`Client ID ${order.client_id}`}>
                <td>{clockTime(order.created_ms)}</td>
                <td>{order.market}</td>
                <td className={side(order) === "Long" ? "rfq-up" : "rfq-down"}>{side(order)}</td>
                <td>{size(order)}</td>
                <td>{filled(order)}</td>
                <td>{price(order.limit_price)}</td>
                <td>
                  <span className={`rfq-badge ${orderTone(order.status)}`} title={order.reason ?? undefined}>
                    {statusLabel(order.status)}
                  </span>
                </td>
                <td>{integer(order.target_block)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <ul className="ops-orders__list">
        {orders.map((order) => (
          <li key={order.client_id}>
            <div>
              <b>
                <span className={side(order) === "Long" ? "rfq-up" : "rfq-down"}>{side(order)}</span> {size(order)}{" "}
                {order.market}
              </b>
              <span className={`rfq-badge ${orderTone(order.status)}`}>{statusLabel(order.status)}</span>
            </div>
            <div className="footnote rfq-muted">
              <span>
                Filled {filled(order)} · limit {price(order.limit_price)}
              </span>
              <span>{clockTime(order.created_ms)}</span>
            </div>
            <div className="caption rfq-faint">
              <span>Block {integer(order.target_block)}</span>
              <span className="mono">{shortId(order.client_id)}</span>
            </div>
            {order.reason && <div className="footnote rfq-down">{order.reason}</div>}
          </li>
        ))}
      </ul>
    </div>
  );
}
