import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource-variable/ibm-plex-sans/wght.css";
import "@fontsource/ibm-plex-mono/500.css";
import "@fontsource/ibm-plex-mono/600.css";
import { MarketsPage } from "./MarketsPage.js";
import { TradePage } from "./TradePage.js";
import { API } from "./config.js";
import "./styles.css";

type View = "trade" | "markets";
const initialView = (): View => new URLSearchParams(window.location.search).get("view") === "markets" ? "markets" : "trade";

function App() {
  const [view, setView] = useState<View>(initialView);
  const [account,setAccount]=useState<string|null>(null);
  const [environment,setEnvironment]=useState({label:"BASE",subtitle:"Perpetuals on Base"});
  useEffect(()=>{let active=true;fetch(`${API}/v1/config`).then(response=>response.ok?response.json():null).then(config=>{
    if(!active||!config?.chainName)return;
    if(config.chainId==="0x7a69")setEnvironment({label:"LOCAL",subtitle:"Local execution sandbox"});
    else if(config.chainId==="0x14a34")setEnvironment({label:"BASE SEPOLIA",subtitle:"Testnet · live Pyth"});
    else setEnvironment({label:String(config.chainName).toUpperCase(),subtitle:"Perpetuals on Base"});
  }).catch(()=>{});return()=>{active=false};},[]);
  const navigate = (next: View) => { setView(next); history.replaceState({}, "", next === "trade" ? location.pathname : `${location.pathname}?view=markets`); };
  return <main className="wide"><div className="app-frame">
    <header className="topbar"><button className="brand" onClick={() => navigate("trade")} aria-label="RFQ Markets home"><span className="wordmark">RFQ<span>/</span></span><span><strong>MARKETS</strong><small>{environment.subtitle}</small></span></button><nav aria-label="Main navigation"><button className={view === "trade" ? "active" : ""} onClick={() => navigate("trade")}>Trade</button><button className={view === "markets" ? "active" : ""} onClick={() => navigate("markets")}>Markets</button></nav><div className="network"><i/>{environment.label}</div><button className="header-wallet" onClick={()=>{navigate("trade");requestAnimationFrame(()=>document.querySelector<HTMLButtonElement>(".trade-wallet")?.click());}}>{account?`${account.slice(0,6)}…${account.slice(-4)}`:"Connect wallet"}</button></header>
    {view === "trade" ? <TradePage onWalletChange={setAccount} /> : <MarketsPage />}
  </div></main>;
}

createRoot(document.getElementById("root")!).render(<App />);
