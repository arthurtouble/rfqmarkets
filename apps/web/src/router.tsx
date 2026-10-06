import { Link, Outlet, createRootRoute, createRoute, createRouter, redirect, useRouterState } from "@tanstack/react-router";
import { useMarketFeed } from "./data/market-feed.js";
import { useIndexerSync } from "./data/queries.js";
import { usdc } from "./lib/format.js";
import { MARKETS, type Market } from "./lib/types.js";
import { MarketsPage } from "./markets/MarketsPage.js";
import { TradePage } from "./trade/TradePage.js";
import { useTrader } from "./wallet/trader.js";
import { WalletMenu } from "./wallet/WalletMenu.js";

const isMarket = (value: string): value is Market => (MARKETS as readonly string[]).includes(value);

function Shell() {
  useIndexerSync();
  const { snapshot, status } = useMarketFeed();
  const { chain } = useTrader();
  const pathname = useRouterState({ select: state => state.location.pathname });
  return <div className="app">
    <header className="topbar">
      <Link to="/trade/$market" params={{ market: "BTC" }} className="brand" aria-label="RFQ Markets home">
        <span className="wordmark">RFQ<span>/</span></span><span><strong>MARKETS</strong><small>Perpetuals on Base</small></span>
      </Link>
      <nav aria-label="Main">
        <Link to="/trade/$market" params={{ market: "BTC" }} className={pathname.startsWith("/trade") ? "active" : ""}>Trade</Link>
        <Link to="/markets" activeProps={{ className: "active" }}>Markets</Link>
      </nav>
      <div className="tickers" aria-label="Prices">
        {MARKETS.map(market => <Link key={market} to="/trade/$market" params={{ market }}><small>{market}</small><span className="mono">{usdc(snapshot?.markets[market].mid)}</span></Link>)}
      </div>
      <span className={`network ${status}`} title={status === "live" ? "Prices streaming" : "Price stream reconnecting"}><i />{chain.name}</span>
      <WalletMenu />
    </header>
    <main><Outlet /></main>
  </div>;
}

const rootRoute = createRootRoute({ component: Shell });

const indexRoute = createRoute({
  getParentRoute: () => rootRoute, path: "/",
  beforeLoad: ({ location }) => {
    // The previous app used ?view=markets; keep old links working.
    const view = new URLSearchParams(location.searchStr).get("view");
    throw redirect(view === "markets" ? { to: "/markets" } : { to: "/trade/$market", params: { market: "BTC" } });
  },
});

const tradeRoute = createRoute({
  getParentRoute: () => rootRoute, path: "/trade/$market",
  params: { parse: ({ market }) => ({ market: market.toUpperCase() }), stringify: ({ market }) => ({ market }) },
  beforeLoad: ({ params }) => { if (!isMarket(params.market)) throw redirect({ to: "/trade/$market", params: { market: "BTC" } }); },
  component: function Trade() { const { market } = tradeRoute.useParams(); return <TradePage market={market as Market} />; },
});

const marketsRoute = createRoute({ getParentRoute: () => rootRoute, path: "/markets", component: MarketsPage });

export const router = createRouter({
  routeTree: rootRoute.addChildren([indexRoute, tradeRoute, marketsRoute]),
  defaultNotFoundComponent: () => <div className="panel not-found"><h1>Page not found</h1><Link to="/trade/$market" params={{ market: "BTC" }}>Go to trading</Link></div>,
});

declare module "@tanstack/react-router" {
  interface Register { router: typeof router }
}
