import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { MarketsPage } from "./MarketsPage.js";
import { TradePage } from "./TradePage.js";
import "./styles.css";

type View = "trade" | "markets";
type Theme = "light" | "dark";
const initialView = (): View => new URLSearchParams(window.location.search).get("view") === "markets" ? "markets" : "trade";
const initialTheme = (): Theme => {
  const saved = localStorage.getItem("rfq-theme");
  if (saved === "light" || saved === "dark") return saved;
  return matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
};
document.documentElement.dataset.theme = initialTheme();

function App() {
  const [view, setView] = useState<View>(initialView);
  const [theme, setTheme] = useState<Theme>(initialTheme);
  const [account,setAccount]=useState<string|null>(null);
  useEffect(() => { document.documentElement.dataset.theme = theme; localStorage.setItem("rfq-theme", theme); }, [theme]);
  const navigate = (next: View) => { setView(next); history.replaceState({}, "", next === "trade" ? location.pathname : `${location.pathname}?view=markets`); };
  return <main className="wide"><div className="app-frame">
    <header className="topbar"><button className="brand" onClick={() => navigate("trade")} aria-label="RFQ Markets home"><span className="wordmark">RFQ<span>/</span></span><span><strong>MARKETS</strong><small>Perpetuals on Base</small></span></button><nav aria-label="Main navigation"><button className={view === "trade" ? "active" : ""} onClick={() => navigate("trade")}>Trade</button><button className={view === "markets" ? "active" : ""} onClick={() => navigate("markets")}>Markets</button></nav><div className="network"><i/>BASE</div><button className="theme-toggle" onClick={() => setTheme(value => value === "light" ? "dark" : "light")} aria-label={`Use ${theme === "light" ? "dark" : "light"} mode`} title={`Use ${theme === "light" ? "dark" : "light"} mode`}><span aria-hidden="true">{theme === "light" ? "☾" : "☀"}</span></button><button className="header-wallet" onClick={()=>{navigate("trade");requestAnimationFrame(()=>document.querySelector<HTMLButtonElement>(".trade-wallet")?.click());}}>{account?`${account.slice(0,6)}…${account.slice(-4)}`:"Connect wallet"}</button></header>
    {view === "trade" ? <TradePage onWalletChange={setAccount} /> : <MarketsPage />}
  </div></main>;
}

createRoot(document.getElementById("root")!).render(<App />);
