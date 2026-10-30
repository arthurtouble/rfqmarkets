import { useTrading } from "../data/actions.js";
import { DOCS_URL, EXIT_URL, LEGAL_LINKS } from "../lib/env.js";
import { addressUrl } from "../lib/explorer.js";
import { shortAddress, usdcCompact } from "../lib/format.js";
import { NavIcons, EmptyState, Segmented } from "../ui/primitives.js";
import { usePrefs } from "../ui/prefs.js";
import { useQuickLimits } from "../data/quick-limits.js";
import { LEGACY_MAX_TRADE_MICRO, QUICK_DAYS } from "../wallet/quick-session.js";
import { useTrader } from "../wallet/trader.js";
import { WrongNetworkBanner } from "../wallet/SwitchNetwork.js";
import { WalletMenu } from "../wallet/WalletMenu.js";

function OneClickRow() {
  const trading = useTrading(),
    session = trading.quickSession,
    busy = trading.busy !== null,
    limits = useQuickLimits();
  const until =
    session &&
    new Date(session.validUntil).toLocaleString([], {
      weekday: "short",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  const limit = usdcCompact(
    session ? BigInt(session.maxTradeNotional ?? LEGACY_MAX_TRADE_MICRO) : limits.maxTradeMicro,
  );
  const detail = !session
    ? `Approve once, then trades up to ${limit} fill without a wallet prompt for ${QUICK_DAYS} days.`
    : session.privateKey
      ? `On until ${until}. Trades up to ${limit} fill without a wallet prompt.`
      : `Off in this browser. Turn it on again, or revoke the old key (it ends ${until} anyway).`;
  return (
    <div className="setting-row">
      <div>
        <div className="headline">One-tap trading</div>
        <div className="footnote rfq-muted">{detail}</div>
      </div>
      <div className="setting-actions">
        {session && (
          <button
            type="button"
            className={`rfq-btn rfq-btn--sm ${session.privateKey ? "rfq-btn--danger" : "rfq-btn--secondary"}`}
            disabled={busy}
            onClick={trading.revokeQuickTrading}
          >
            {session.privateKey ? "Turn off" : "Revoke"}
          </button>
        )}
        {!session?.privateKey && (
          <button
            type="button"
            className="rfq-btn rfq-btn--sm rfq-btn--primary"
            disabled={busy}
            onClick={() => void trading.enableQuickTrading(limits)}
          >
            {session ? "Turn on again" : "Turn on"}
          </button>
        )}
      </div>
    </div>
  );
}

export function AccountPage() {
  const trader = useTrader();
  const { theme, setTheme } = usePrefs();
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
        {trader.address && <OneClickRow />}
      </section>
      <section className="rfq-card" aria-label="Preferences">
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
