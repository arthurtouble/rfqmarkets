import { useEffect, useState } from "react";
import { INDEXER, base, dollars, getJson, shortAddress } from "./config.js";
import type { Market, Position, Risk, TradeActivity } from "./types.js";

type Health = { ok: boolean; indexedBlock: number; finalizedBlock: number; headBlock: number; lag: number };
type PublicSnapshot = { risk: Risk; positions: { items: Position[]; total: number }; activity: { items: TradeActivity[] }; health: Health };
const signedBase = (value: string, market: Market) => `${BigInt(value) > 0n ? "+" : ""}${base(value)} ${market}`;

function MarketExposure({ market, data }: { market: Market; data: Risk["markets"][Market] }) {
  const long = Number(BigInt(data.longBase)), short = Number(BigInt(data.shortBase)), total = long + short;
  return <article className="exposure-card">
    <div className="card-title"><strong>{market}-PERP</strong><span className={BigInt(data.netBase) >= 0n ? "positive" : "negative"}>{signedBase(data.netBase, market)} net</span></div>
    <div className="exposure-bar"><span style={{ width: `${total ? long / total * 100 : 50}%` }} /><i /></div>
    <div className="exposure-sides"><div><small>Long</small><strong>{base(data.longBase)} {market}</strong><span>{data.longAccounts} accounts</span></div><div><small>Short</small><strong>{base(data.shortBase)} {market}</strong><span>{data.shortAccounts} accounts</span></div></div>
  </article>;
}

export function MarketsPage() {
  const [snapshot, setSnapshot] = useState<PublicSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    const refresh = async () => {
      try {
        const [risk, positions, activity, health] = await Promise.all([
          getJson<Risk>(`${INDEXER}/v1/risk?finalized=true`, controller.signal),
          getJson<PublicSnapshot["positions"]>(`${INDEXER}/v1/positions?finalized=true&limit=100`, controller.signal),
          getJson<PublicSnapshot["activity"]>(`${INDEXER}/v1/activity?kind=TradeExecuted&finalized=true&limit=30`, controller.signal),
          getJson<Health>(`${INDEXER}/health`, controller.signal),
        ]);
        setSnapshot({ risk, positions, activity, health }); setUpdatedAt(new Date()); setError(null);
      } catch (reason) { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : "Indexer unavailable"); }
    };
    void refresh(); const timer = setInterval(refresh, 2_000);
    return () => { controller.abort(); clearInterval(timer); };
  }, []);

  if (!snapshot) return <section className="public-dashboard empty"><div className="eyebrow">Chain activity</div><h1>Loading finalized state…</h1>{error && <p>{error}</p>}</section>;
  const { risk, positions, activity, health } = snapshot;
  return <section className="public-dashboard">
    <div className="dashboard-heading"><div><div className="eyebrow"><i className={health.ok ? "online" : ""} /> Chain-derived · Finalized</div><h1>Market activity</h1><p>Open positions and executions indexed from the public settlement contract.</p></div><div className="block-state"><span>Finalized block</span><strong>{risk.indexedBlock.toLocaleString()}</strong><small>{health.lag === 0 ? "Indexer caught up" : `${health.lag} blocks behind`} · updated {updatedAt?.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</small></div></div>
    {error && <div className="warning">Last refresh failed: {error}. Showing the last complete snapshot.</div>}
    <div className="summary-grid"><article><small>Deposited collateral</small><strong>{dollars(risk.totalCollateral)}</strong></article><article><small>Indexed accounts</small><strong>{risk.accountCount}</strong></article><article><small>Open positions</small><strong>{positions.total}</strong></article></div>
    <div className="exposure-grid"><MarketExposure market="BTC" data={risk.markets.BTC} /><MarketExposure market="ETH" data={risk.markets.ETH} /></div>
    <div className="data-panel"><div className="panel-heading"><div><h2>Open positions</h2><p>Pseudonymous wallet state at the finalized block.</p></div><span>{positions.total} total</span></div><div className="table-wrap"><table><thead><tr><th>Wallet</th><th>Collateral</th><th>BTC position</th><th>BTC entry</th><th>ETH position</th><th>ETH entry</th></tr></thead><tbody>{positions.items.length ? positions.items.map(position => <tr key={position.account}><td className="mono" title={position.account}>{shortAddress(position.account)}</td><td>{dollars(position.collateral)}</td><td className={BigInt(position.positions.BTC.size) >= 0n ? "positive" : "negative"}>{signedBase(position.positions.BTC.size, "BTC")}</td><td>{BigInt(position.positions.BTC.size) ? dollars(position.positions.BTC.entryPrice) : "—"}</td><td className={BigInt(position.positions.ETH.size) >= 0n ? "positive" : "negative"}>{signedBase(position.positions.ETH.size, "ETH")}</td><td>{BigInt(position.positions.ETH.size) ? dollars(position.positions.ETH.entryPrice) : "—"}</td></tr>) : <tr><td colSpan={6} className="none">No open positions</td></tr>}</tbody></table></div></div>
    <div className="data-panel"><div className="panel-heading"><div><h2>Recent trades</h2><p>Confirmed settlement events, newest first.</p></div><span>{activity.items.length} shown</span></div><div className="table-wrap"><table><thead><tr><th>Time</th><th>Wallet</th><th>Market</th><th>Side</th><th>Size</th><th>Price</th><th>Fee</th><th>Block</th></tr></thead><tbody>{activity.items.length ? activity.items.map(trade => { const market: Market = trade.market === 0 ? "BTC" : "ETH"; const buy = BigInt(trade.payload.baseDelta) > 0n; return <tr key={`${trade.tx_hash}:${trade.log_index}`}><td>{new Date(trade.timestamp * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</td><td className="mono" title={trade.account}>{shortAddress(trade.account)}</td><td>{market}-PERP</td><td><span className={`side-pill ${buy ? "positive" : "negative"}`}>{buy ? "Buy" : "Sell"}</span></td><td>{base(((buy ? 1n : -1n) * BigInt(trade.payload.baseDelta)).toString())} {market}</td><td>{dollars(trade.payload.price)}</td><td>{dollars(trade.payload.fee)}</td><td className="mono">{trade.block_number}</td></tr>; }) : <tr><td colSpan={8} className="none">No trades indexed</td></tr>}</tbody></table></div></div>
  </section>;
}
