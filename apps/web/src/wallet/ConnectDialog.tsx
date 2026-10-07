import { useEffect } from "react";
import { useConnect, useConnectors, type Connector } from "wagmi";
import { Sheet } from "../ui/primitives.js";
import { useTrader } from "./trader.js";
import { GET_A_WALLET, walletErrorMessage, walletLabel, walletSections } from "./wallets.js";

const hasInjectedProvider = () => typeof window !== "undefined" && "ethereum" in window && !!(window as { ethereum?: unknown }).ethereum;
const touchDevice = () => typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches;

const WalletConnectLogo = () => <svg viewBox="0 0 36 36" aria-hidden="true"><rect width="36" height="36" rx="10" fill="#3B99FC" /><path fill="#fff" d="M11.5 14.1c3.6-3.5 9.4-3.5 13 0l.4.4c.2.2.2.5 0 .6l-1.5 1.5a.2.2 0 0 1-.3 0l-.6-.6a6.3 6.3 0 0 0-9 0l-.6.6a.2.2 0 0 1-.3 0L11 15.1a.4.4 0 0 1 0-.6l.5-.4Zm16 3 1.3 1.3c.2.2.2.5 0 .6l-5.9 5.8a.5.5 0 0 1-.6 0l-4.2-4.1a.1.1 0 0 0-.2 0l-4.2 4.1a.5.5 0 0 1-.6 0L7.2 19c-.2-.1-.2-.4 0-.6l1.3-1.3a.5.5 0 0 1 .6 0l4.2 4.1h.2l4.2-4.1a.5.5 0 0 1 .6 0l4.2 4.1h.2l4.2-4.1a.5.5 0 0 1 .6 0Z" /></svg>;

function WalletIcon({ connector }: { connector: Connector }) {
  if (connector.type === "walletConnect") return <span className="wallet-glyph"><WalletConnectLogo /></span>;
  if (connector.icon) return <img src={connector.icon} alt="" width={36} height={36} />;
  return <span className={`wallet-glyph ${connector.type}`} aria-hidden="true">{connector.type === "baseAccount" ? "" : connector.name.slice(0, 1)}</span>;
}

/**
 * The connect sheet: installed wallets, Base Account passkeys and phone wallets.
 * A wallet left waiting (its window closed without an answer) never blocks the
 * others: picking any option starts a fresh request.
 */
export function ConnectDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const trader = useTrader();
  const connectors = useConnectors();
  const { mutate: connect, isPending, variables, error, reset } = useConnect();

  useEffect(() => { if (open) reset(); }, [open, reset]);
  useEffect(() => { if (trader.address) onClose(); }, [trader.address, onClose]);

  const sections = walletSections(connectors, hasInjectedProvider());
  const pending = isPending ? (variables?.connector as Connector | undefined)?.uid : undefined;
  const pick = (connector: Connector) => {
    // WalletConnect draws its own QR modal, which cannot sit above ours.
    if (connector.type === "walletConnect") onClose();
    connect({ connector, chainId: trader.chain.id });
  };
  const option = (connector: Connector, detail: string) => <button key={connector.uid} type="button" className="wallet-option" aria-busy={pending === connector.uid} onClick={() => pick(connector)}>
    <WalletIcon connector={connector} />
    <span><strong>{walletLabel(connector)}</strong><small>{pending === connector.uid ? "Check your wallet…" : detail}</small></span>
  </button>;

  // Plain divs rather than <p>: the sheet can render inside an empty state, whose paragraph styles would leak in.
  return <Sheet open={open} onClose={onClose} title="Connect a wallet" labelledBy="connect-title">
    <div className="sheet-body connect-sheet">
      <div className="body rfq-muted">Trade on {trader.chain.name}. Your wallet signs every order, and RFQ Markets never holds your keys.</div>
      {sections.installed.length > 0 && <section className="wallet-group" aria-labelledby="wallets-installed">
        <h3 id="wallets-installed">Installed</h3>
        {sections.installed.map(connector => option(connector, "Browser extension"))}
      </section>}
      {sections.passkey.length > 0 && <section className="wallet-group" aria-labelledby="wallets-passkey">
        <h3 id="wallets-passkey">{sections.installed.length > 0 ? "Passkey" : "No wallet yet"}</h3>
        {sections.passkey.map(connector => option(connector, "Sign in with a passkey. Nothing to install."))}
      </section>}
      {sections.remote.length > 0 && <section className="wallet-group" aria-labelledby="wallets-remote">
        <h3 id="wallets-remote">Phone and other wallets</h3>
        {sections.remote.map(connector => option(connector, touchDevice() ? "Open Rainbow, Trust, MetaMask and 500+ more" : "Scan a QR code with Rainbow, Trust, MetaMask and 500+ more"))}
      </section>}
      {trader.devWalletAvailable && <section className="wallet-group" aria-labelledby="wallets-dev">
        <h3 id="wallets-dev">Development</h3>
        <button type="button" className="wallet-option" onClick={() => { trader.useDevWallet(); onClose(); }}>
          <span className="wallet-glyph dev" aria-hidden="true">D</span>
          <span><strong>Local dev wallet</strong><small>Funded key from the local stack</small></span>
        </button>
      </section>}
      {error && <div className="rfq-banner rfq-banner--warning" role="alert">{walletErrorMessage(error, trader.chain.name)}</div>}
      {sections.installed.length === 0 && (touchDevice()
        ? <div className="footnote rfq-muted">Have a wallet app? Open this page in its built-in browser, or pick WalletConnect above.</div>
        : <div className="footnote rfq-muted">No browser wallet found. Get one: {GET_A_WALLET.map((wallet, index) => <span key={wallet.name}>{index > 0 && " · "}<a href={wallet.url} target="_blank" rel="noreferrer">{wallet.name}</a></span>)}</div>)}
    </div>
  </Sheet>;
}
