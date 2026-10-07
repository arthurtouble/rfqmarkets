import { useTrading } from "../data/actions.js";
import { DOCS_URL, EXIT_URL } from "../lib/env.js";
import { addressUrl } from "../lib/explorer.js";
import { shortAddress } from "../lib/format.js";
import { NavIcons, EmptyState, Segmented } from "../ui/primitives.js";
import { usePrefs } from "../ui/prefs.js";
import { QUICK_LIMITS } from "../wallet/quick-session.js";
import { useTrader } from "../wallet/trader.js";
import { WalletMenu } from "../wallet/WalletMenu.js";

function OneClickRow() {
  const trading = useTrading(), session = trading.quickSession, busy = trading.busy !== null;
  const limit = `$${Number(QUICK_LIMITS.maxTradeAmount).toLocaleString("en-US")}`;
  const until = session && new Date(session.validUntil).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const detail = !session ? `Trades up to ${limit} fill without a wallet prompt for 8 hours.`
    : session.privateKey ? `On until ${until} for trades up to ${limit}.`
    : `Reloading the page cleared this tab's key. The permission lasts until ${until}; turn it off or on again.`;
  return <div className="setting-row">
    <div><div className="headline">One-click trading</div><div className="footnote rfq-muted">{detail}</div></div>
    <div className="setting-actions">
      {session && <button type="button" className="rfq-btn rfq-btn--sm rfq-btn--danger" disabled={busy} onClick={trading.revokeQuickTrading}>Turn off</button>}
      {!session?.privateKey && <button type="button" className="rfq-btn rfq-btn--sm rfq-btn--primary" disabled={busy} onClick={trading.enableQuickTrading}>Turn on</button>}
    </div>
  </div>;
}

export function AccountPage() {
  const trader = useTrader();
  const { mode, setMode, theme, setTheme } = usePrefs();
  const explorer = trader.address ? addressUrl(trader.chain.id, trader.address) : undefined;
  return <div className="page narrow account-page">
    <h1 className="title-1 page-title">Account</h1>
    <section className="rfq-card" aria-label="Wallet">
      {trader.address ? <div className="setting-row">
        <div className="wallet-line"><span className="rfq-avatar" aria-hidden="true" /><div><div className="headline mono-addr">{shortAddress(trader.address)}</div><div className="footnote rfq-muted">{trader.source === "dev" ? "Local dev wallet" : "Connected"} on {trader.chain.name}</div></div></div>
        <div className="setting-actions">
          {explorer && <a className="rfq-btn rfq-btn--sm rfq-btn--ghost" href={explorer} target="_blank" rel="noreferrer">Explorer</a>}
          <button type="button" className="rfq-btn rfq-btn--sm rfq-btn--secondary" onClick={trader.disconnect}>Disconnect</button>
        </div>
      </div> : <EmptyState icon={NavIcons.account} action={<WalletMenu />}>Connect a wallet to trade. We never hold your keys.</EmptyState>}
      {trader.address && <OneClickRow />}
    </section>
    <section className="rfq-card" aria-label="Preferences">
      <div className="setting-row">
        <div><div className="headline">View</div><div className="footnote rfq-muted">Advanced adds limit orders, reduce only and price details.</div></div>
        <Segmented variant="switch" label="View" value={mode} onChange={setMode} options={[{ id: "simple", label: "Simple" }, { id: "advanced", label: "Advanced" }]} />
      </div>
      <div className="setting-row">
        <div><div className="headline">Appearance</div></div>
        <Segmented variant="switch" label="Appearance" value={theme} onChange={setTheme} options={[{ id: "system", label: "System" }, { id: "light", label: "Light" }, { id: "dark", label: "Dark" }]} />
      </div>
    </section>
    <section className="rfq-card links" aria-label="Help">
      <a className="setting-row link-row" href={DOCS_URL} target="_blank" rel="noreferrer"><div><div className="headline">Help and docs</div><div className="footnote rfq-muted">How trading, margin and fees work.</div></div><span aria-hidden="true">↗</span></a>
      <a className="setting-row link-row" href={EXIT_URL} target="_blank" rel="noreferrer"><div><div className="headline">Emergency exit</div><div className="footnote rfq-muted">Withdraw straight from the contract if this app is ever down.</div></div><span aria-hidden="true">↗</span></a>
    </section>
  </div>;
}
