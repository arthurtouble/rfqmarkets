// Open positions (cards on phones, a table on desktop), the close sheet for one
// position and the close-all sheet. Math lives in lib/positions.ts.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useIdleMargin, useIsolatedAccounts } from "../account/useAccount.js";
import { useTrading } from "../data/actions.js";
import { useMarketFeed, useServerNow } from "../data/market-feed.js";
import { useProtocol } from "../data/queries.js";
import { baseAmount, feeLabel, signedUsdc, usdc, usdPrice } from "../lib/format.js";
import {
  CLOSE_PRESETS,
  closeAllPreview,
  closePreview,
  isNearLiquidation,
  openPositions,
  positionView,
  type PositionView,
} from "../lib/positions.js";
import { indicativeQuote, marketFeeBps } from "../lib/quote.js";
import type { AccountState, Market } from "../lib/types.js";
import { AssetIcon, Banner, Change, Rows, Segmented, Sheet, marketName } from "../ui/primitives.js";
import { useDesktop } from "../ui/prefs.js";
import { ProtectionSummary, TpslSheet } from "../trade/TriggerOrders.js";

const percent = (fraction: number | null) =>
  fraction === null ? "" : `${fraction > 0 ? "+" : ""}${(fraction * 100).toFixed(2)}%`;
const sideWord = (view: PositionView) => (view.long ? "long" : "short");
const SideBadge = ({ view }: { view: PositionView }) => (
  <span className={`rfq-badge rfq-badge--${view.long ? "long" : "short"}`}>
    {view.long ? "Long" : "Short"}
  </span>
);

function Pnl({ view }: { view: PositionView }) {
  return (
    <>
      <Change value={view.pnl}>{signedUsdc(view.pnl)}</Change>
      <div className={`caption ${view.pnl > 0n ? "rfq-up" : view.pnl < 0n ? "rfq-down" : "rfq-faint"}`}>
        {percent(view.roe)}
      </div>
    </>
  );
}

const LiquidationPrice = ({ view }: { view: PositionView }) => (
  <span className={isNearLiquidation(view) ? "rfq-down" : undefined}>{usdPrice(view.liquidationPrice)}</span>
);

function NearLiquidation({ view }: { view: PositionView }) {
  if (!isNearLiquidation(view)) return null;
  return (
    <Banner tone="danger">
      <b>Close to liquidation.</b> {view.market} is {((view.liquidationDistance ?? 0) * 100).toFixed(1)}%
      away. Add funds or reduce the position.
    </Banner>
  );
}

/**
 * One open position and the account holding it: the main (cross margin) account, or the market's isolated
 * account for a trade opened with isolated margin. Home and Pro trade the same accounts, so a market holds one
 * cross position whichever screen opened it.
 */
export type PositionRow = { view: PositionView; holder: AccountState; isolated: boolean };
const rowKey = (row: PositionRow) => `${row.isolated ? "isolated" : "cross"}:${row.view.market}`;
const rowLabel = (row: PositionRow) =>
  `${row.view.market} ${sideWord(row.view)}${row.isolated ? " isolated" : ""}`;

/** The margin tag: only isolated positions carry one, since cross is the default. */
const MarginTag = ({ row }: { row: PositionRow }) =>
  row.isolated ? (
    <span className="rfq-badge" title="Isolated margin: this position's loss stops at its own margin">
      Isolated
    </span>
  ) : null;

/** Without `onTpsl` the TP/SL controls are left out. */
type PositionActions = {
  onClose: (row: PositionRow) => void;
  onTpsl?: (row: PositionRow) => void;
};
/** The account a row's TP/SL rests on, when it is not the trader's own (an isolated account). */
const holderOf = (row: PositionRow) => (row.isolated ? row.holder.account : undefined);

export function PositionCard({ row, onClose, onTpsl }: { row: PositionRow } & PositionActions) {
  const { view } = row;
  return (
    <article className="rfq-pos" aria-label={rowLabel(row)}>
      <div className="rfq-pos__head">
        <AssetIcon market={view.market} small />
        <span className="headline">{view.market}</span>
        <SideBadge view={view} />
        <MarginTag row={row} />
        <span className="rfq-pos__pnl num">
          <Pnl view={view} />
        </span>
      </div>
      <div className="rfq-pos__grid">
        <div>
          <span>Size</span>
          <b>{usdc(view.notional)}</b>
        </div>
        <div>
          <span>Entry</span>
          <b>{usdPrice(view.entryPrice)}</b>
        </div>
        <div>
          <span>Mark</span>
          <b>{usdPrice(view.markPrice)}</b>
        </div>
        <div>
          <span>Margin</span>
          <b>{usdc(view.margin)}</b>
        </div>
        <div>
          <span>Liq. price</span>
          <b className={isNearLiquidation(view) ? "rfq-down" : undefined}>
            {usdPrice(view.liquidationPrice)}
          </b>
        </div>
        <div>
          <span>Funding</span>
          <b>{signedUsdc(view.funding)}</b>
        </div>
      </div>
      {onTpsl && (
        <div className="rfq-pos__tpsl">
          <span>TP/SL</span>
          <ProtectionSummary
            market={view.market}
            size={view.long ? view.size : -view.size}
            account={holderOf(row)}
          />
        </div>
      )}
      <NearLiquidation view={view} />
      <div className="rfq-pos__actions">
        {onTpsl && (
          <button
            type="button"
            className="rfq-btn rfq-btn--secondary"
            aria-label={`Set ${view.market} take-profit and stop-loss`}
            onClick={() => onTpsl(row)}
          >
            TP/SL
          </button>
        )}
        <button
          type="button"
          className="rfq-btn rfq-btn--secondary"
          aria-label={`Close ${rowLabel(row)}`}
          onClick={() => onClose(row)}
        >
          Close
        </button>
      </div>
    </article>
  );
}

function PositionsTable({
  rows,
  onClose,
  onTpsl,
  onCloseAll,
}: { rows: PositionRow[]; onCloseAll?: () => void } & PositionActions) {
  return (
    <div className="rfq-table-wrap">
      <table className="rfq-table positions-table">
        <thead>
          <tr>
            <th>Market</th>
            <th>Size</th>
            <th>Entry / mark</th>
            <th>Liq. price</th>
            <th>Margin</th>
            <th>Funding</th>
            <th>PnL</th>
            <th>TP/SL</th>
            <th>
              {onCloseAll ? (
                <button type="button" className="rfq-btn rfq-btn--sm rfq-btn--ghost" onClick={onCloseAll}>
                  Close all
                </button>
              ) : (
                <span className="visually-hidden">Actions</span>
              )}
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const { view } = row;
            return (
              <tr key={rowKey(row)}>
                <td>
                  <span className="cell-market">
                    <AssetIcon market={view.market} small />
                    {view.market}
                    <SideBadge view={view} />
                    <MarginTag row={row} />
                  </span>
                </td>
                <td>
                  {usdc(view.notional)}
                  <div className="caption rfq-faint">
                    {baseAmount(view.size)} {view.market}
                  </div>
                </td>
                <td>
                  {usdPrice(view.entryPrice)}
                  <div className="caption rfq-faint">{usdPrice(view.markPrice)}</div>
                </td>
                <td>
                  <LiquidationPrice view={view} />
                </td>
                <td>{usdc(view.margin)}</td>
                <td>{signedUsdc(view.funding)}</td>
                <td>
                  <Pnl view={view} />
                </td>
                <td>
                  {onTpsl ? (
                    <button
                      type="button"
                      className="tpsl-cell"
                      aria-label={`Set ${view.market} take-profit and stop-loss`}
                      onClick={() => onTpsl(row)}
                    >
                      <ProtectionSummary
                        market={view.market}
                        size={view.long ? view.size : -view.size}
                        empty="Add"
                        account={holderOf(row)}
                      />
                    </button>
                  ) : (
                    <span className="rfq-faint">—</span>
                  )}
                </td>
                <td>
                  <button
                    type="button"
                    className="rfq-btn rfq-btn--sm rfq-btn--secondary"
                    aria-label={`Close ${rowLabel(row)}`}
                    onClick={() => onClose(row)}
                  >
                    Close
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** Every open position: the main account's (cross margin) first, then any isolated ones, by market. */
export function positionRows(account: AccountState | null, isolatedAccounts: AccountState[]): PositionRow[] {
  return [
    ...openPositions(account).map((view) => ({ view, holder: account!, isolated: false })),
    ...isolatedAccounts.flatMap((holder) =>
      openPositions(holder).map((view) => ({ view, holder, isolated: true })),
    ),
  ];
}

/**
 * Every open position in one list with its close and TP/SL actions: a table on desktop, cards on phones or
 * when `only` limits the list to one market (the mobile trade page). Positions opened with isolated margin sit
 * in the list with an Isolated tag; Close all covers the cross positions, which close together.
 */
export function Positions({ account, only }: { account: AccountState | null; only?: Market }) {
  const desktop = useDesktop();
  const isolatedAccounts = useIsolatedAccounts();
  const [closing, setClosing] = useState<string | null>(null);
  const [closingAll, setClosingAll] = useState(false);
  const [protecting, setProtecting] = useState<string | null>(null);
  const rows = positionRows(account, isolatedAccounts).filter((row) => !only || row.view.market === only);
  if (!rows.length) return null;
  const cross = rows.filter((row) => !row.isolated).map((row) => row.view);
  const closingRow = rows.find((row) => rowKey(row) === closing);
  const closingView = closingRow ? positionView(closingRow.holder, closingRow.view.market) : null;
  const protectingRow = rows.find((row) => rowKey(row) === protecting);
  const onClose = (row: PositionRow) => setClosing(rowKey(row));
  const onTpsl = (row: PositionRow) => setProtecting(rowKey(row));
  const onCloseAll = !only && cross.length > 1 ? () => setClosingAll(true) : undefined;
  return (
    <section className="positions" aria-label="Open positions">
      {desktop && !only ? (
        <>
          {rows.map((row) => (
            <NearLiquidation key={rowKey(row)} view={row.view} />
          ))}
          <PositionsTable rows={rows} onClose={onClose} onTpsl={onTpsl} onCloseAll={onCloseAll} />
        </>
      ) : (
        <>
          {onCloseAll && (
            <div className="positions__bar">
              <button type="button" className="rfq-btn rfq-btn--sm rfq-btn--secondary" onClick={onCloseAll}>
                Close all
              </button>
            </div>
          )}
          <div className="positions__cards">
            {rows.map((row) => (
              <PositionCard key={rowKey(row)} row={row} onClose={onClose} onTpsl={onTpsl} />
            ))}
          </div>
        </>
      )}
      {closingView && closingRow && (
        <ClosePositionSheet
          view={closingView}
          onClose={() => setClosing(null)}
          isolated={closingRow.isolated}
        />
      )}
      {protectingRow && (
        <TpslSheet
          account={protectingRow.holder}
          market={protectingRow.view.market}
          onClose={() => setProtecting(null)}
        />
      )}
      {closingAll && <CloseAllSheet positions={cross} onClose={() => setClosingAll(false)} />}
    </section>
  );
}

type Preset = `${(typeof CLOSE_PRESETS)[number]}`;

/**
 * Close a share of one position at a firm quote, or all of it at the oracle price while trading is paused.
 * `isolated` closes a position held with isolated margin, whose margin returns to the balance once it is fully closed.
 */
export function ClosePositionSheet({
  view,
  onClose,
  isolated = false,
}: {
  view: PositionView;
  onClose: () => void;
  isolated?: boolean;
}) {
  const trading = useTrading(),
    protocol = useProtocol(),
    { snapshot } = useMarketFeed(),
    now = useServerNow(1_000);
  const paused = protocol.data?.paused ?? false;
  const [preset, setPreset] = useState<Preset>("100");
  const fractionBps = paused ? 10_000 : Number(preset) * 100;
  const live = snapshot?.markets[view.market];
  // The firm close quote prices an exact size; the local indicative quote for the same notional estimates price and fee.
  const rough = closePreview(view, fractionBps, live);
  const indicative =
    snapshot && !paused && rough.closingNotional > 0n
      ? indicativeQuote(snapshot, view.market, view.long ? "sell" : "buy", rough.closingNotional, now)
      : null;
  const quote = indicative && "quote" in indicative ? indicative.quote : null;
  const preview =
    paused && live
      ? closePreview(view, fractionBps, null, BigInt(live.mid))
      : quote
        ? closePreview(view, fractionBps, null, BigInt(quote.expectedPrice))
        : rough;
  const fee = quote ? BigInt(quote.fee) : null;
  const net = preview.realizedPnl - (fee ?? 0n);
  const busy = trading.busy !== null;
  // The oracle-price exit closes the main account's position only; an isolated one waits for trading to resume.
  const blocked = paused && isolated;
  const label = paused
    ? `Close ${view.market} at oracle price`
    : fractionBps === 10_000
      ? `Close ${view.market} ${sideWord(view)}`
      : `Close ${preset}% of ${view.market} ${sideWord(view)}`;
  // The sheet stays open when the close fails, so the error toast sits beside a way to try again.
  const close = async () => {
    const closed = paused
      ? await trading.emergencyClose(view.market)
      : !!(await trading.closePosition(view.market, fractionBps, isolated));
    if (closed) onClose();
  };
  return (
    <Sheet open onClose={onClose} title={`Close ${view.market} ${sideWord(view)}`} labelledBy="close-title">
      <div className="sheet-body">
        {blocked ? (
          <Banner tone="warning">
            <b>Trading is paused.</b> You can close this isolated position once trading resumes.
          </Banner>
        ) : paused ? (
          <Banner tone="warning">
            <b>Trading is paused.</b> You can still close the whole position at the oracle price.
          </Banner>
        ) : (
          <Segmented
            label="Amount to close"
            value={preset}
            onChange={setPreset}
            options={CLOSE_PRESETS.map((value) => ({ id: String(value) as Preset, label: `${value}%` }))}
          />
        )}
        <Rows
          rows={[
            [
              "Closing",
              `${baseAmount(preview.closingSize)} ${view.market} · ${usdc(preview.closingNotional)}`,
            ],
            ["Estimated price", usdPrice(preview.price)],
            ["Fee", paused ? "None" : feeLabel(fee, marketFeeBps(snapshot, view.market))],
            [
              "Left open",
              preview.remainingSize > 0n ? `${baseAmount(preview.remainingSize)} ${view.market}` : "Nothing",
            ],
            [
              "Estimated PnL",
              <Change key="pnl" value={net}>
                {signedUsdc(net)}
              </Change>,
              "is-total",
            ],
          ]}
        />
        <button
          type="button"
          className="rfq-btn rfq-btn--lg rfq-btn--primary rfq-btn--block"
          disabled={busy || blocked}
          onClick={close}
        >
          {busy ? (
            <>
              <span className="rfq-spinner" />
              Closing…
            </>
          ) : (
            label
          )}
        </button>
      </div>
    </Sheet>
  );
}

/** Close every open position: one firm quote each, or one oracle-price exit each while paused. */
export function CloseAllSheet({ positions, onClose }: { positions: PositionView[]; onClose: () => void }) {
  const trading = useTrading(),
    protocol = useProtocol(),
    { snapshot } = useMarketFeed();
  const paused = protocol.data?.paused ?? false;
  const total = closeAllPreview(positions, snapshot?.markets ?? {});
  const busy = trading.busy !== null;
  const close = async () => {
    let closedAny = false;
    if (paused)
      for (const view of positions) closedAny = (await trading.emergencyClose(view.market)) || closedAny;
    else closedAny = !!(await trading.closeAll())?.closed.length;
    if (closedAny) onClose();
  };
  return (
    <Sheet open onClose={onClose} title="Close all positions" labelledBy="close-all-title">
      <div className="sheet-body">
        {paused && (
          <Banner tone="warning">
            <b>Trading is paused.</b> Each position closes at the oracle price, one wallet prompt each.
          </Banner>
        )}
        <Rows
          rows={[
            ...positions.map(
              (view) =>
                [
                  <span key="market" className="cell-market">
                    <AssetIcon market={view.market} small />
                    {view.market}
                    <SideBadge view={view} />
                  </span>,
                  <Change key="pnl" value={view.pnl}>
                    {signedUsdc(view.pnl)}
                  </Change>,
                ] as [ReactNode, ReactNode],
            ),
            ["Closing", usdc(total.notional)],
            [
              "Estimated PnL",
              <Change key="total" value={total.realizedPnl}>
                {signedUsdc(total.realizedPnl)}
              </Change>,
              "is-total",
            ],
          ]}
        />
        {!paused && (
          <p className="footnote rfq-muted">
            Each position gets its own quote, and they close without wallet prompts.
          </p>
        )}
        <button
          type="button"
          className="rfq-btn rfq-btn--lg rfq-btn--danger rfq-btn--block"
          disabled={busy}
          onClick={close}
        >
          {busy ? (
            <>
              <span className="rfq-spinner" />
              Closing…
            </>
          ) : (
            `Close ${positions.length} positions`
          )}
        </button>
      </div>
    </Sheet>
  );
}

/**
 * Money an isolated trade set aside in its own isolated account that has no open position (a trade that did not go
 * through after its amount was moved). The balance and Withdraw don't count it, so it is offered back here.
 */
/** How long margin must sit with no position before it is offered back: reads can trail a fill by a few blocks. */
const IDLE_AFTER_MS = 20_000;

export function IdleMargin() {
  const all = useIdleMargin();
  const trading = useTrading();
  // Right after a trade fills, the account read can show the margin without the position for a few seconds;
  // only margin that stays idle is offered back.
  const since = useRef(new Map<string, number>());
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!all.length) return;
    const timer = setInterval(() => setNow(Date.now()), 5_000);
    return () => clearInterval(timer);
  }, [all.length]);
  for (const key of [...since.current.keys()])
    if (!all.some((item) => item.account === key)) since.current.delete(key);
  for (const item of all) if (!since.current.has(item.account)) since.current.set(item.account, now);
  const idle = all.filter((item) => now - since.current.get(item.account)! >= IDLE_AFTER_MS);
  if (!idle.length) return null;
  const busy = trading.busy !== null;
  return (
    <section className="rfq-card rfq-card--pad stack idle-margin" aria-label="Set aside">
      {idle.map((item) => (
        <div key={item.account} className="idle-margin__row">
          <p className="footnote">
            <b className="tnum">{usdc(item.heldMicro)}</b> is set aside for a {marketName(item.market)} trade
            that didn't go through. It isn't in your balance until you return it.
          </p>
          <button
            type="button"
            className="rfq-btn rfq-btn--sm rfq-btn--secondary"
            disabled={busy}
            aria-label={`Return ${usdc(item.heldMicro)} from ${item.market} to your balance`}
            onClick={() => void trading.returnMargin(item.market)}
          >
            Return to balance
          </button>
        </div>
      ))}
    </section>
  );
}
