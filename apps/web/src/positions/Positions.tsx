// Open positions (cards on phones, a table on desktop), the close sheet for one
// position and the close-all sheet. Math lives in lib/positions.ts.
import { useState, type ReactNode } from "react";
import { useTrading } from "../data/actions.js";
import { useMarketFeed, useNow } from "../data/market-feed.js";
import { useProtocol } from "../data/queries.js";
import { baseAmount, signedUsdc, usdc } from "../lib/format.js";
import {
  CLOSE_PRESETS,
  closeAllPreview,
  closePreview,
  isNearLiquidation,
  openPositions,
  positionView,
  type PositionView,
} from "../lib/positions.js";
import { indicativeQuote } from "../lib/quote.js";
import type { AccountState, Market } from "../lib/types.js";
import { AssetIcon, Banner, Change, Rows, Segmented, Sheet } from "../ui/primitives.js";
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
  <span className={isNearLiquidation(view) ? "rfq-down" : undefined}>{usdc(view.liquidationPrice)}</span>
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

/** Without `onTpsl` (Home bets, which hold their own margin) the TP/SL controls are left out. */
type PositionActions = { onClose: (market: Market) => void; onTpsl?: (market: Market) => void };

export function PositionCard({ view, onClose, onTpsl }: { view: PositionView } & PositionActions) {
  return (
    <article className="rfq-pos" aria-label={`${view.market} ${sideWord(view)}`}>
      <div className="rfq-pos__head">
        <AssetIcon market={view.market} small />
        <span className="headline">{view.market}</span>
        <SideBadge view={view} />
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
          <b>{usdc(view.entryPrice)}</b>
        </div>
        <div>
          <span>Mark</span>
          <b>{usdc(view.markPrice)}</b>
        </div>
        <div>
          <span>Margin</span>
          <b>{usdc(view.margin)}</b>
        </div>
        <div>
          <span>Liq. price</span>
          <b className={isNearLiquidation(view) ? "rfq-down" : undefined}>{usdc(view.liquidationPrice)}</b>
        </div>
        <div>
          <span>Funding</span>
          <b>{signedUsdc(view.funding)}</b>
        </div>
      </div>
      {onTpsl && (
        <div className="rfq-pos__tpsl">
          <span>TP/SL</span>
          <ProtectionSummary market={view.market} size={view.long ? view.size : -view.size} />
        </div>
      )}
      <NearLiquidation view={view} />
      <div className="rfq-pos__actions">
        {onTpsl && (
          <button
            type="button"
            className="rfq-btn rfq-btn--secondary"
            aria-label={`Set ${view.market} take-profit and stop-loss`}
            onClick={() => onTpsl(view.market)}
          >
            TP/SL
          </button>
        )}
        <button
          type="button"
          className="rfq-btn rfq-btn--secondary"
          aria-label={`Close ${view.market} ${sideWord(view)}`}
          onClick={() => onClose(view.market)}
        >
          Close
        </button>
      </div>
    </article>
  );
}

function PositionsTable({
  positions,
  onClose,
  onTpsl,
  onCloseAll,
}: { positions: PositionView[]; onCloseAll?: () => void } & PositionActions) {
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
          {positions.map((view) => (
            <tr key={view.market}>
              <td>
                <span className="cell-market">
                  <AssetIcon market={view.market} small />
                  {view.market}
                  <SideBadge view={view} />
                </span>
              </td>
              <td>
                {usdc(view.notional)}
                <div className="caption rfq-faint">
                  {baseAmount(view.size)} {view.market}
                </div>
              </td>
              <td>
                {usdc(view.entryPrice)}
                <div className="caption rfq-faint">{usdc(view.markPrice)}</div>
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
                    onClick={() => onTpsl(view.market)}
                  >
                    <ProtectionSummary
                      market={view.market}
                      size={view.long ? view.size : -view.size}
                      empty="Add"
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
                  aria-label={`Close ${view.market} ${sideWord(view)}`}
                  onClick={() => onClose(view.market)}
                >
                  Close
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * Open positions with their close actions: a table on desktop, cards on phones
 * or when `only` limits the list to one market (the mobile trade page).
 */
export function Positions({ account, only }: { account: AccountState | null; only?: Market }) {
  const desktop = useDesktop();
  const [closing, setClosing] = useState<Market | null>(null);
  const [closingAll, setClosingAll] = useState(false);
  const [protecting, setProtecting] = useState<Market | null>(null);
  const positions = openPositions(account).filter((view) => !only || view.market === only);
  if (!account || !positions.length) return null;
  const closingView = closing ? positionView(account, closing) : null;
  return (
    <div className="positions">
      {desktop && !only ? (
        <>
          {positions.map((view) => (
            <NearLiquidation key={view.market} view={view} />
          ))}
          <PositionsTable
            positions={positions}
            onClose={setClosing}
            onTpsl={setProtecting}
            onCloseAll={positions.length > 1 ? () => setClosingAll(true) : undefined}
          />
        </>
      ) : (
        <>
          {!only && positions.length > 1 && (
            <div className="positions__bar">
              <button
                type="button"
                className="rfq-btn rfq-btn--sm rfq-btn--secondary"
                onClick={() => setClosingAll(true)}
              >
                Close all
              </button>
            </div>
          )}
          <div className="positions__cards">
            {positions.map((view) => (
              <PositionCard key={view.market} view={view} onClose={setClosing} onTpsl={setProtecting} />
            ))}
          </div>
        </>
      )}
      {closingView && <ClosePositionSheet view={closingView} onClose={() => setClosing(null)} />}
      {protecting && positions.some((view) => view.market === protecting) && (
        <TpslSheet account={account} market={protecting} onClose={() => setProtecting(null)} />
      )}
      {closingAll && <CloseAllSheet positions={positions} onClose={() => setClosingAll(false)} />}
    </div>
  );
}

type Preset = `${(typeof CLOSE_PRESETS)[number]}`;

/**
 * Close a share of one position at a firm quote, or all of it at the oracle price while trading is paused.
 * `isolated` closes a Home bet on its own margin, which returns to the balance once it is fully closed.
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
    now = useNow(1_000);
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
  // The oracle-price exit closes the main account's position only; a Home bet waits for trading to resume.
  const blocked = paused && isolated;
  const label = paused
    ? `Close ${view.market} at oracle price`
    : fractionBps === 10_000
      ? `Close ${view.market} ${sideWord(view)}`
      : `Close ${preset}% of ${view.market} ${sideWord(view)}`;
  const close = async () => {
    if (paused) await trading.emergencyClose(view.market);
    else await trading.closePosition(view.market, fractionBps, isolated);
    onClose();
  };
  return (
    <Sheet open onClose={onClose} title={`Close ${view.market} ${sideWord(view)}`} labelledBy="close-title">
      <div className="sheet-body">
        {blocked ? (
          <Banner tone="warning">
            <b>Trading is paused.</b> You can cash out this Home bet once trading resumes.
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
            ["Estimated price", usdc(preview.price)],
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
    if (paused) for (const view of positions) await trading.emergencyClose(view.market);
    else await trading.closeAll();
    onClose();
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
            Each position gets its own quote. With one-tap trading on, they close without wallet prompts.
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
 * Open Home bets: one-tap trades that each hold their own margin in an isolated account, so the stake is the
 * most they can lose. They close in full or in part here; TP/SL and close-all stay with the main account.
 */
export function HomeBets({ accounts }: { accounts: AccountState[] }) {
  const desktop = useDesktop();
  const [closing, setClosing] = useState<Market | null>(null);
  const bets = accounts.flatMap((account) => openPositions(account).map((view) => ({ account, view })));
  if (!bets.length) return null;
  const views = bets.map((bet) => bet.view);
  const closingBet = closing ? bets.find((bet) => bet.view.market === closing) : undefined;
  const closingView = closingBet ? positionView(closingBet.account, closingBet.view.market) : null;
  return (
    <section className="positions home-bets" aria-label="Home bets">
      <div className="positions__bar">
        <span className="footnote rfq-muted">Home bets, each on its own margin</span>
      </div>
      {desktop ? (
        <PositionsTable positions={views} onClose={setClosing} />
      ) : (
        <div className="positions__cards">
          {views.map((view) => (
            <PositionCard key={view.market} view={view} onClose={setClosing} />
          ))}
        </div>
      )}
      {closingView && <ClosePositionSheet view={closingView} onClose={() => setClosing(null)} isolated />}
    </section>
  );
}
