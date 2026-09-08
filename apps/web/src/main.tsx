import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { MarketsPage } from "./MarketsPage.js";
import { TradePage } from "./TradePage.js";
import "./styles.css";

type View = "trade" | "markets";
const initialView = (): View => new URLSearchParams(window.location.search).get("view") === "markets" ? "markets" : "trade";

function App() {
  const [view, setView] = useState<View>(initialView);
  const navigate = (next: View) => { setView(next); history.replaceState({}, "", next === "trade" ? location.pathname : `${location.pathname}?view=markets`); };
  return <main className={view === "markets" ? "wide" : ""}><div className="app-frame">
    <header className="topbar"><button className="brand" onClick={() => navigate("trade")}><span className="mark">R</span><span><strong>RFQ Markets</strong><small>Local prototype</small></span></button><nav aria-label="Main navigation"><button className={view === "trade" ? "active" : ""} onClick={() => navigate("trade")}>Trade</button><button className={view === "markets" ? "active" : ""} onClick={() => navigate("markets")}>Markets</button></nav></header>
    {view === "trade" ? <TradePage /> : <MarketsPage />}
  </div></main>;
}

createRoot(document.getElementById("root")!).render(<App />);
