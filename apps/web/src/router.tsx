import {
  Link,
  Outlet,
  createRootRoute,
  createRoute,
  createRouter,
  redirect,
  useRouterState,
} from "@tanstack/react-router";
import { useIndexerSync } from "./data/queries.js";
import { useOrderFillAlerts } from "./trade/TriggerOrders.js";
import type { Market } from "./lib/types.js";
import { AccountPage } from "./account/AccountPage.js";
import { RestrictedNotice, TermsDialog, UnavailableHere, useLocationStatus } from "./legal/LegalGate.js";
import { MarketsPage } from "./markets/MarketsPage.js";
import { PortfolioPage } from "./portfolio/PortfolioPage.js";
import { FundsProvider, useFunds } from "./trade/FundsDialog.js";
import { TradePage } from "./trade/TradePage.js";
import { UpDownPage } from "./updown/UpDownPage.js";
import { NavIcons } from "./ui/primitives.js";
import { load, store } from "./lib/storage.js";
import { useTrader } from "./wallet/trader.js";
import { WalletMenu } from "./wallet/WalletMenu.js";

// Markets are listed on chain and can be added any time, so any symbol-shaped path is a market.
const isMarket = (value: string): value is Market => /^[A-Z0-9]{2,12}$/.test(value);
const LAST_MARKET = "rfq.market";
const lastMarket = (): Market => {
  const value = load(LAST_MARKET) ?? "";
  return isMarket(value) ? value : "BTC";
};

/** Market paths read in upper case: /trade/eth and /updown/eth become .../ETH. */
const marketParams = {
  parse: ({ market }: { market: string }) => ({ market: market.toUpperCase() }),
  stringify: ({ market }: { market: string }) => ({ market }),
};
/** One address per market, and the last one visited becomes the default. */
function guardMarket(to: "/trade/$market" | "/updown/$market", market: string, pathname: string) {
  if (!isMarket(market)) throw redirect({ to, params: { market: "BTC" } });
  if (pathname !== to.replace("$market", market)) throw redirect({ to, params: { market }, replace: true });
  store(LAST_MARKET, market);
}

function Shell() {
  return (
    <FundsProvider>
      <ShellLayout />
    </FundsProvider>
  );
}

function ShellLayout() {
  useIndexerSync();
  useOrderFillAlerts();
  const funds = useFunds();
  const trader = useTrader();
  const location = useLocationStatus();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const section = pathname.startsWith("/markets")
    ? "markets"
    : pathname.startsWith("/portfolio")
      ? "portfolio"
      : pathname.startsWith("/account")
        ? "account"
        : "home";
  const current = (name: string) => (section === name ? ("page" as const) : undefined);
  return (
    <div className="app">
      <header className="rfq-topbar topbar">
        <Link
          to="/updown/$market"
          params={{ market: lastMarket() }}
          className="rfq-logo"
          aria-label="RFQ Markets home"
        >
          RFQ Markets
        </Link>
        <nav className="rfq-nav" aria-label="Main">
          <Link to="/updown/$market" params={{ market: lastMarket() }} aria-current={current("home")}>
            Home
          </Link>
          <Link to="/markets" aria-current={current("markets")}>
            Markets
          </Link>
          <Link to="/portfolio" aria-current={current("portfolio")}>
            Portfolio
          </Link>
        </nav>
        <div className="rfq-topbar__end">
          {trader.address && !trader.wrongChain && (
            <button
              type="button"
              className="rfq-btn rfq-btn--primary rfq-btn--sm"
              onClick={() => funds.open("deposit")}
            >
              Deposit
            </button>
          )}
          <WalletMenu />
        </div>
      </header>
      {trader.settlementError && (
        <div className="notice warn settlement-error" role="alert">
          {trader.settlementError}
        </div>
      )}
      <main>
        {location.status === "restricted" && <RestrictedNotice message={location.message} />}
        {location.status === "sanctioned" ? <UnavailableHere message={location.message} /> : <Outlet />}
      </main>
      {location.status !== "sanctioned" && <TermsDialog />}
      <nav className="rfq-tabbar tabbar" aria-label="Main">
        <Link to="/updown/$market" params={{ market: lastMarket() }} aria-current={current("home")}>
          {NavIcons.home}
          <span>Home</span>
        </Link>
        <Link to="/markets" aria-current={current("markets")}>
          {NavIcons.markets}
          <span>Markets</span>
        </Link>
        <Link to="/portfolio" aria-current={current("portfolio")}>
          {NavIcons.portfolio}
          <span>Portfolio</span>
        </Link>
        <Link to="/account" aria-current={current("account")}>
          {NavIcons.account}
          <span>Account</span>
        </Link>
      </nav>
    </div>
  );
}

const rootRoute = createRootRoute({ component: Shell });

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  beforeLoad: ({ location }) => {
    // The previous app used ?view=markets; keep old links working.
    const view = new URLSearchParams(location.searchStr).get("view");
    throw redirect(
      view === "markets" ? { to: "/markets" } : { to: "/updown/$market", params: { market: lastMarket() } },
    );
  },
});

const tradeRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/trade/$market",
  params: marketParams,
  beforeLoad: ({ params, location }) => guardMarket("/trade/$market", params.market, location.pathname),
  component: function Trade() {
    const { market } = tradeRoute.useParams();
    return <TradePage market={market as Market} />;
  },
});

/** The home screen: Up or Down on one market. Paths normalise like the terminal's. */
const upDownRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/updown/$market",
  params: marketParams,
  beforeLoad: ({ params, location }) => guardMarket("/updown/$market", params.market, location.pathname),
  component: function Home() {
    const { market } = upDownRoute.useParams();
    return <UpDownPage market={market as Market} />;
  },
});

const marketsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/markets",
  component: MarketsPage,
});
const portfolioRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/portfolio",
  component: PortfolioPage,
});
const accountRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/account",
  component: AccountPage,
});

export const router = createRouter({
  routeTree: rootRoute.addChildren([
    indexRoute,
    upDownRoute,
    tradeRoute,
    marketsRoute,
    portfolioRoute,
    accountRoute,
  ]),
  defaultNotFoundComponent: () => (
    <div className="page">
      <div className="rfq-card">
        <div className="rfq-empty">
          <p>This page doesn't exist.</p>
          <Link className="rfq-btn rfq-btn--primary" to="/updown/$market" params={{ market: "BTC" }}>
            Go to trading
          </Link>
        </div>
      </div>
    </div>
  ),
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
