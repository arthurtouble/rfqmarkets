import React from "react";
import { createRoot } from "react-dom/client";
import "@fontsource-variable/ibm-plex-sans/wght.css";
import "@fontsource/ibm-plex-mono/500.css";
import "./styles.css";
import { decimal, type Market, usd, useOperationsData } from "./operations.js";

const markets:Market[]=["BTC","ETH"];

function App(){
  const {risk,hedge,error}=useOperationsData();
  return <main>
    <header>
      <div><span className="eyebrow">PRIVATE OPERATIONS</span><h1>Hedge operations</h1><p>Finalized Base exposure and independent venue reconciliation</p></div>
      <div className={hedge?.healthy?"health ok":"health"}><i/>{hedge?.healthy?"Healthy":"Unavailable"}<small>block {hedge?.indexedBlock??"—"}</small></div>
    </header>
    {error&&<div className="alert">{error}</div>}
    <section className="summary">
      <article><span>Customer collateral</span><strong>{risk?usd(risk.totalCollateral):"—"}</strong><small>{risk?.accountCount??"—"} funded accounts</small></article>
      <article><span>Hedge venue</span><strong>{hedge?.mode??"—"}</strong><small>Independent capital account</small></article>
      <article><span>Finalized block</span><strong>{hedge?.indexedBlock??"—"}</strong><small>Indexer head {risk?.indexedBlock??"—"}</small></article>
    </section>
    <section className="markets">{markets.map(market=>{
      const exposure=risk?.markets[market],venue=hedge?.markets[market],gross=exposure?BigInt(exposure.longBase)+BigInt(exposure.shortBase):0n,longPct=gross?Number(BigInt(exposure!.longBase)*100n/gross):50;
      return <article key={market}>
        <div className="title"><div><b>{market}</b><span>PERP</span></div><em className={venue?.state}>{venue?.state==="within_band"?"Within band":"Action required"}</em></div>
        <div className="flow"><div><span>Customer longs</span><strong>{exposure?decimal(exposure.longBase,18):"—"} {market}</strong><small>{exposure?.longAccounts??0} accounts</small></div><div className="right"><span>Customer shorts</span><strong>{exposure?decimal(exposure.shortBase,18):"—"} {market}</strong><small>{exposure?.shortAccounts??0} accounts</small></div></div>
        <div className="bar"><i style={{width:`${longPct}%`}}/></div>
        <dl><div><dt>Net customer</dt><dd>{exposure?decimal(exposure.netBase,18):"—"} {market}</dd></div><div><dt>Venue hedge</dt><dd>{venue?decimal(venue.venueBase,18):"—"} {market}</dd></div><div><dt>Unhedged gap</dt><dd>{venue?decimal(venue.gapBase,18):"—"} {market}</dd></div><div><dt>Gap notional</dt><dd>{venue?usd(venue.gapNotional):"—"}</dd></div><div><dt>Action band</dt><dd>{venue?usd(venue.bandUsdc):"—"}</dd></div></dl>
      </article>;
    })}</section>
    <section className="orders">
      <div className="sectionTitle"><h2>Recent hedge orders</h2><span>Stable client IDs · IOC limits</span></div>
      {hedge?.orders.length?<table><thead><tr><th>Market</th><th>Delta</th><th>Limit</th><th>Status</th><th>Block</th></tr></thead><tbody>{hedge.orders.map(order=><tr key={order.client_id}><td>{order.market}</td><td>{decimal(order.base_delta,18)}</td><td>{usd(order.limit_price)}</td><td><span className="pill">{order.status}</span></td><td>{order.target_block}</td></tr>)}</tbody></table>:<div className="empty">No hedge orders. Exposure remains inside the configured action band.</div>}
    </section>
    <footer>No trading keys or control actions are exposed to this interface.</footer>
  </main>;
}

createRoot(document.getElementById("root")!).render(<App/>);
