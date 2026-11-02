import { DOCS_URL, EXIT_URL, LEGAL_LINKS } from "../lib/env.js";
import { addressUrl } from "../lib/explorer.js";
import { shortAddress } from "../lib/format.js";
import { NavIcons, EmptyState, Segmented } from "../ui/primitives.js";
import { usePrefs } from "../ui/prefs.js";
import { useTrader } from "../wallet/trader.js";
import { WrongNetworkBanner } from "../wallet/SwitchNetwork.js";
import { WalletMenu } from "../wallet/WalletMenu.js";

export function AccountPage() {
  const trader = useTrader();
  const { theme, setTheme, view, setView, marginMode, setMarginMode } = usePrefs();
  const explorer = trader.address ? addressUrl(trader.chain.id, trader.address) : undefined;
  return (
    <div className="page narrow account-page">
      <h1 className="title-1 page-title">Account</h1>
      <section className="rfq-card" aria-label="Wallet">
        {trader.wrongChain && (
          <div className="setting-row account-banner">
            <WrongNetworkBanner />
          </div>
        )}
        {trader.address ? (
          <div className="setting-row">
            <div className="wallet-line">
              {trader.wallet?.icon ? (
                <img className="wallet-line__icon" src={trader.wallet.icon} alt="" width={40} height={40} />
              ) : (
                <span className={`rfq-avatar ${trader.source === "dev" ? "dev" : ""}`} aria-hidden="true" />
              )}
              <div>
                <div className="headline mono-addr">{shortAddress(trader.address)}</div>
                <div className="footnote rfq-muted">
                  {trader.source === "dev" ? "Local dev wallet" : (trader.wallet?.name ?? "Wallet")} ·{" "}
                  {trader.wrongChain ? "wrong network" : trader.chain.name}
                </div>
              </div>
            </div>
            <div className="setting-actions">
              {explorer && (
                <a
                  className="rfq-btn rfq-btn--sm rfq-btn--ghost"
                  href={explorer}
                  target="_blank"
                  rel="noreferrer"
                >
                  Explorer
                </a>
              )}
              <button
                type="button"
                className="rfq-btn rfq-btn--sm rfq-btn--secondary"
                onClick={trader.disconnect}
              >
                Disconnect
              </button>
            </div>
          </div>
        ) : (
          <EmptyState icon={NavIcons.account} action={<WalletMenu />}>
            Connect a wallet to trade. We never hold your keys.
          </EmptyState>
        )}
      </section>
      <section className="rfq-card" aria-label="Preferences">
        <div className="setting-row">
          <div>
            <div className="headline">Trading view</div>
            <div className="footnote rfq-muted">
              What Home opens. Simple is Up or Down; Pro adds the full order ticket. Same account and
              positions either way.
            </div>
          </div>
          <Segmented
            variant="switch"
            label="Trading view"
            value={view}
            onChange={setView}
            options={[
              { id: "simple", label: "Simple" },
              { id: "pro", label: "Pro" },
            ]}
          />
        </div>
        <div className="setting-row">
          <div>
            <div className="headline">Default margin</div>
            <div className="footnote rfq-muted">
              Cross shares your balance across positions, one per market. Isolated sets each trade's margin
              aside, so that is the most it can lose. You can also change it on the order form.
            </div>
          </div>
          <Segmented
            variant="switch"
            label="Default margin"
            value={marginMode}
            onChange={setMarginMode}
            options={[
              { id: "cross", label: "Cross" },
              { id: "isolated", label: "Isolated" },
            ]}
          />
        </div>
        <div className="setting-row">
          <div>
            <div className="headline">Appearance</div>
          </div>
          <Segmented
            variant="switch"
            label="Appearance"
            value={theme}
            onChange={setTheme}
            options={[
              { id: "system", label: "System" },
              { id: "light", label: "Light" },
              { id: "dark", label: "Dark" },
            ]}
          />
        </div>
      </section>
      <section className="rfq-card links" aria-label="Help">
        <a className="setting-row link-row" href={DOCS_URL} target="_blank" rel="noreferrer">
          <div>
            <div className="headline">Help and docs</div>
            <div className="footnote rfq-muted">How trading, margin and closing work.</div>
          </div>
          <span aria-hidden="true">↗</span>
        </a>
        <a className="setting-row link-row" href={EXIT_URL} target="_blank" rel="noreferrer">
          <div>
            <div className="headline">Emergency exit</div>
            <div className="footnote rfq-muted">
              Withdraw straight from the contract if this app is ever down.
            </div>
          </div>
          <span aria-hidden="true">↗</span>
        </a>
      </section>
      <section className="rfq-card links" aria-label="Legal">
        {(
          [
            ["Terms of Service", LEGAL_LINKS.terms],
            ["Privacy Policy", LEGAL_LINKS.privacy],
            ["Risk Disclosure", LEGAL_LINKS.risk],
            ["Restricted jurisdictions", LEGAL_LINKS.jurisdictions],
          ] as const
        ).map(([label, href]) => (
          <a key={href} className="setting-row link-row" href={href} target="_blank" rel="noreferrer">
            <div>
              <div className="headline">{label}</div>
            </div>
            <span aria-hidden="true">↗</span>
          </a>
        ))}
      </section>
    </div>
  );
}
