import { Link, Outlet, createRootRoute, createRoute, createRouter, redirect, useRouterState } from "@tanstack/react-router";
import { useIndexerSync } from "./data/queries.js";
import { useOrderFillAlerts } from "./trade/TriggerOrders.js";
import type { Market } from "./lib/types.js";
import { AccountPage } from "./account/AccountPage.js";
import { MarketsPage } from "./markets/MarketsPage.js";
import { PortfolioPage } from "./portfolio/PortfolioPage.js";
import { FundsProvider, useFunds } from "./trade/FundsDialog.js";
import { TradePage } from "./trade/TradePage.js";
import { NavIcons, Segmented } from "./ui/primitives.js";
import { usePrefs } from "./ui/prefs.js";
import { useTrader } from "./wallet/trader.js";
import { WalletMenu } from "./wallet/WalletMenu.js";

// Markets are listed on chain and can be added any time, so any symbol-shaped path is a market.
const isMarket = (value: string): value is Market => /^[A-Z0-9]{2,12}$/.test(value);
const LAST_MARKET = "rfq.market";
const lastMarket = (): Market => { try { const value = localStorage.getItem(LAST_MARKET) ?? ""; return isMarket(value) ? value : "BTC"; } catch { return "BTC"; } };

function Shell() {
  return <FundsProvider><ShellLayout /></FundsProvider>;
}

function ShellLayout() {
  useIndexerSync();
  useOrderFillAlerts();
  const funds = useFunds();
  const { mode, setMode } = usePrefs();
  const trader = useTrader();
  const pathname = useRouterState({ select: state => state.location.pathname });
  const section = pathname.startsWith("/markets") ? "markets" : pathname.startsWith("/portfolio") ? "portfolio" : pathname.startsWith("/account") ? "account" : "trade";
  const current = (name: string) => (section === name ? "page" as const : undefined);
  return <div className="app">
    <header className="rfq-topbar topbar">
      <Link to="/trade/$market" params={{ market: lastMarket() }} className="rfq-logo" aria-label="RFQ Markets home">RFQ Markets</Link>
      <nav className="rfq-nav" aria-label="Main">
        <Link to="/trade/$market" params={{ market: lastMarket() }} aria-current={current("trade")}>Trade</Link>
        <Link to="/markets" aria-current={current("markets")}>Markets</Link>
        <Link to="/portfolio" aria-current={current("portfolio")}>Portfolio</Link>
      </nav>
      <div className="rfq-topbar__end">
        <Segmented variant="switch" className="mode-switch" label="View" value={mode} onChange={setMode}
          options={[{ id: "simple", label: "Simple" }, { id: "advanced", label: "Advanced" }]} />
        {trader.address && !trader.wrongChain && <button type="button" className="rfq-btn rfq-btn--primary rfq-btn--sm" onClick={() => funds.open("deposit")}>Deposit</button>}
        <WalletMenu />
      </div>
    </header>
    <main><Outlet /></main>
    <nav className="rfq-tabbar tabbar" aria-label="Main">
      <Link to="/trade/$market" params={{ market: lastMarket() }} aria-current={current("trade")}>{NavIcons.trade}<span>Trade</span></Link>
      <Link to="/markets" aria-current={current("markets")}>{NavIcons.markets}<span>Markets</span></Link>
      <Link to="/portfolio" aria-current={current("portfolio")}>{NavIcons.portfolio}<span>Portfolio</span></Link>
      <Link to="/account" aria-current={current("account")}>{NavIcons.account}<span>Account</span></Link>
    </nav>
  </div>;
}

const rootRoute = createRootRoute({ component: Shell });

const indexRoute = createRoute({
  getParentRoute: () => rootRoute, path: "/",
  beforeLoad: ({ location }) => {
    // The previous app used ?view=markets; keep old links working.
    const view = new URLSearchParams(location.searchStr).get("view");
    throw redirect(view === "markets" ? { to: "/markets" } : { to: "/trade/$market", params: { market: lastMarket() } });
  },
});

const tradeRoute = createRoute({
  getParentRoute: () => rootRoute, path: "/trade/$market",
  params: { parse: ({ market }) => ({ market: market.toUpperCase() }), stringify: ({ market }) => ({ market }) },
  beforeLoad: ({ params }) => {
    if (!isMarket(params.market)) throw redirect({ to: "/trade/$market", params: { market: "BTC" } });
    try { localStorage.setItem(LAST_MARKET, params.market); } catch { /* private mode */ }
  },
  component: function Trade() { const { market } = tradeRoute.useParams(); return <TradePage market={market as Market} />; },
});

const marketsRoute = createRoute({ getParentRoute: () => rootRoute, path: "/markets", component: MarketsPage });
const portfolioRoute = createRoute({ getParentRoute: () => rootRoute, path: "/portfolio", component: PortfolioPage });
const accountRoute = createRoute({ getParentRoute: () => rootRoute, path: "/account", component: AccountPage });

export const router = createRouter({
  routeTree: rootRoute.addChildren([indexRoute, tradeRoute, marketsRoute, portfolioRoute, accountRoute]),
  defaultNotFoundComponent: () => <div className="page"><div className="rfq-card"><div className="rfq-empty"><p>This page doesn't exist.</p><Link className="rfq-btn rfq-btn--primary" to="/trade/$market" params={{ market: "BTC" }}>Go to trading</Link></div></div></div>,
});

declare module "@tanstack/react-router" {
  interface Register { router: typeof router }
}
