import { useEffect, useState } from "react";
import { LEADERBOARD_SIZE, useLeaderboard, usePoints } from "../data/leaderboard.js";
import { shortAddress, signedUsdc, usdcCompact } from "../lib/format.js";
import {
  SORTS,
  WINDOWS,
  countdown,
  findTrader,
  pointsLabel,
  pointsSummary,
  weekEnd,
} from "../lib/leaderboard.js";
import { storedChoice, store } from "../lib/storage.js";
import type { LeaderboardEntry, LeaderboardSort, LeaderboardWindow } from "../lib/types.js";
import { EmptyState, NavIcons, Segmented } from "../ui/primitives.js";
import { useDesktop } from "../ui/prefs.js";
import { useTrader } from "../wallet/trader.js";
import { WalletMenu } from "../wallet/WalletMenu.js";

const tone = (value: string) => (BigInt(value) > 0n ? "rfq-up" : BigInt(value) < 0n ? "rfq-down" : "");
const trades = (count: number) => `${count} ${count === 1 ? "trade" : "trades"}`;

/** Re-renders once a minute so the week countdown moves. */
function useMinuteClock() {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

function PointsCard({ you }: { you?: LeaderboardEntry }) {
  const { address } = useTrader();
  const points = usePoints(address);
  const now = useMinuteClock();
  const summary = pointsSummary(points.data, now);
  return (
    <section className="rfq-card rfq-card--pad stack points-card" aria-label="Your points">
      <div className="points-card__head">
        <div>
          <div className="footnote rfq-muted">Your points this week</div>
          <div className="balance tnum">{address ? pointsLabel(summary.thisWeek) : "—"}</div>
        </div>
        {you && <span className="rfq-badge rfq-badge--brand">Rank #{you.rank}</span>}
      </div>
      {address ? (
        <dl className="stat-grid">
          <div>
            <dt>All time</dt>
            <dd className="tnum">{points.isError ? "—" : pointsLabel(summary.total)}</dd>
          </div>
          <div>
            <dt>New week in</dt>
            <dd className="tnum">{countdown(weekEnd(now), now)}</dd>
          </div>
        </dl>
      ) : (
        <WalletMenu connectLabel="Connect to earn points" />
      )}
      <p className="caption rfq-faint">
        Every $100 you trade earns 1 point, on Home and in Pro. Weeks start Thursday 00:00 UTC.
      </p>
    </section>
  );
}

function TraderName({ entry, you }: { entry: LeaderboardEntry; you: boolean }) {
  return (
    <span className="leader__name">
      <span className="mono" title={entry.account}>
        {shortAddress(entry.account)}
      </span>
      {you && <span className="rfq-badge rfq-badge--brand">You</span>}
    </span>
  );
}

function BoardTable({ traders, address }: { traders: LeaderboardEntry[]; address: string | null }) {
  return (
    <div className="rfq-table-wrap">
      <table className="rfq-table leaderboard-table">
        <thead>
          <tr>
            <th scope="col">Rank</th>
            <th scope="col">Trader</th>
            <th scope="col">Volume</th>
            <th scope="col">PnL</th>
            <th scope="col">Trades</th>
            <th scope="col">Points</th>
          </tr>
        </thead>
        <tbody>
          {traders.map((entry) => {
            const you = !!findTrader([entry], address);
            return (
              <tr key={entry.account} className={you ? "is-you" : undefined}>
                <td className={`leader__rank${entry.rank <= 3 ? " is-top" : ""}`}>{entry.rank}</td>
                <td>
                  <TraderName entry={entry} you={you} />
                </td>
                <td className="tnum">{usdcCompact(entry.volume)}</td>
                <td className={`tnum ${tone(entry.netPnl)}`}>{signedUsdc(entry.netPnl)}</td>
                <td className="tnum">{entry.tradeCount}</td>
                <td className="tnum">{pointsLabel(entry.points)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function BoardList({
  traders,
  address,
  sort,
}: {
  traders: LeaderboardEntry[];
  address: string | null;
  sort: LeaderboardSort;
}) {
  return (
    <ol className="rfq-list leaderboard-list">
      {traders.map((entry) => {
        const you = !!findTrader([entry], address);
        return (
          <li key={entry.account} className={`leader${you ? " is-you" : ""}`}>
            <span className={`leader__rank${entry.rank <= 3 ? " is-top" : ""}`}>{entry.rank}</span>
            <span>
              <TraderName entry={entry} you={you} />
              <span className="rfq-row__sub">
                {trades(entry.tradeCount)} · {pointsLabel(entry.points)} pts
              </span>
            </span>
            <span className="rfq-row__end">
              {sort === "volume" ? (
                <>
                  <span className="rfq-row__price">{usdcCompact(entry.volume)}</span>
                  <span className={`caption ${tone(entry.netPnl)}`}>{signedUsdc(entry.netPnl)}</span>
                </>
              ) : (
                <>
                  <span className={`rfq-row__price ${tone(entry.netPnl)}`}>{signedUsdc(entry.netPnl)}</span>
                  <span className="caption rfq-muted">{usdcCompact(entry.volume)} volume</span>
                </>
              )}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

export function LeaderboardPage() {
  const desktop = useDesktop();
  const { address } = useTrader();
  const [period, setPeriodState] = useState<LeaderboardWindow>(() =>
    storedChoice("rfq.leaderboard.window", ["1d", "7d", "30d", "all"], "7d"),
  );
  const [sort, setSortState] = useState<LeaderboardSort>(() =>
    storedChoice("rfq.leaderboard.sort", ["volume", "pnl"], "volume"),
  );
  const setPeriod = (next: LeaderboardWindow) => {
    store("rfq.leaderboard.window", next);
    setPeriodState(next);
  };
  const setSort = (next: LeaderboardSort) => {
    store("rfq.leaderboard.sort", next);
    setSortState(next);
  };
  const board = useLeaderboard(period, sort);
  const traders = board.data?.traders ?? [];
  const you = findTrader(traders, address);

  return (
    <div className="page leaderboard-page">
      <h1 className="title-1 page-title">Leaderboard</h1>
      <PointsCard you={you} />
      <section className="rfq-card leaderboard" aria-labelledby="leaderboard-title">
        <div className="leaderboard__head">
          <h2 className="headline" id="leaderboard-title">
            Top traders
          </h2>
          <div className="leaderboard__controls">
            <Segmented label="Period" value={period} onChange={setPeriod} options={[...WINDOWS]} />
            <Segmented label="Rank by" value={sort} onChange={setSort} options={[...SORTS]} />
          </div>
        </div>
        {board.isError && !board.data ? (
          <EmptyState icon={NavIcons.leaderboard}>The leaderboard is unavailable right now.</EmptyState>
        ) : traders.length ? (
          <div className={board.isPlaceholderData ? "is-updating" : undefined} aria-busy={board.isFetching}>
            {desktop ? (
              <BoardTable traders={traders} address={address} />
            ) : (
              <BoardList traders={traders} address={address} sort={sort} />
            )}
            {traders.length === LEADERBOARD_SIZE && (
              <p className="caption rfq-faint leaderboard__foot">Showing the top {LEADERBOARD_SIZE}.</p>
            )}
          </div>
        ) : (
          <EmptyState mood="idle">
            {board.isPending
              ? "Loading the leaderboard…"
              : "No trades in this period yet. Yours could be first."}
          </EmptyState>
        )}
      </section>
    </div>
  );
}
