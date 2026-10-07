import { useEffect, useRef } from "react";
import { useConnect, useConnectors, type Connector } from "wagmi";
import { errorMessage } from "../lib/http.js";
import { useTrader } from "./trader.js";
import { GET_A_WALLET, walletLabel, walletSections } from "./wallets.js";

const hasInjectedProvider = () => typeof window !== "undefined" && "ethereum" in window && !!(window as { ethereum?: unknown }).ethereum;

function WalletIcon({ connector }: { connector: Connector }) {
  if (connector.icon) return <img src={connector.icon} alt="" width={28} height={28} />;
  return <span className={`wallet-glyph ${connector.type}`} aria-hidden="true">{connector.type === "baseAccount" ? "" : connector.name.slice(0, 1)}</span>;
}

/** The connect modal: installed wallets, Base Account passkeys and phone wallets. */
export function ConnectDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const trader = useTrader();
  const connectors = useConnectors();
  const { mutate: connect, isPending, variables, error, reset } = useConnect();

  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (open && !element.open) { reset(); element.showModal(); }
    if (!open && element.open) element.close();
  }, [open, reset]);
  useEffect(() => { if (trader.address) onClose(); }, [trader.address, onClose]);

  const sections = walletSections(connectors, hasInjectedProvider());
  const pending = isPending ? (variables?.connector as Connector | undefined)?.uid : undefined;
  const pick = (connector: Connector) => {
    // WalletConnect draws its own QR modal, which cannot sit above ours.
    if (connector.type === "walletConnect") onClose();
    connect({ connector, chainId: trader.chain.id });
  };
  const option = (connector: Connector, detail: string) => <button key={connector.uid} type="button" className="wallet-option" disabled={isPending} onClick={() => pick(connector)}>
    <WalletIcon connector={connector} />
    <span><strong>{walletLabel(connector)}</strong><small>{pending === connector.uid ? "Check your wallet…" : detail}</small></span>
  </button>;

  return <dialog ref={dialog} className="dialog connect-dialog" onClose={onClose} aria-labelledby="connect-title">
    <header><h2 id="connect-title">Connect a wallet</h2><button type="button" className="icon" aria-label="Close" onClick={onClose}>×</button></header>
    <p className="dialog-copy">Trade on {trader.chain.name}. Your wallet signs each order and RFQ Markets never holds your keys.</p>
    {sections.installed.length > 0 && <section className="wallet-group" aria-label="Installed wallets">
      <h3>Installed</h3>
      {sections.installed.map(connector => option(connector, "Browser extension"))}
    </section>}
    {sections.passkey.length > 0 && <section className="wallet-group" aria-label="Passkey wallet">
      <h3>No wallet yet</h3>
      {sections.passkey.map(connector => option(connector, "Sign in with a passkey. Nothing to install."))}
    </section>}
    {sections.remote.length > 0 && <section className="wallet-group" aria-label="Phone wallets">
      <h3>Phone and other wallets</h3>
      {sections.remote.map(connector => option(connector, "Scan a QR code with Rainbow, Trust, MetaMask mobile and 500+ more"))}
    </section>}
    {trader.devWalletAvailable && <section className="wallet-group" aria-label="Development">
      <h3>Development</h3>
      <button type="button" className="wallet-option" onClick={() => { trader.useDevWallet(); onClose(); }}>
        <span className="wallet-glyph dev" aria-hidden="true">D</span>
        <span><strong>Local dev wallet</strong><small>Funded key from the local stack</small></span>
      </button>
    </section>}
    {error && <p className="notice warn">{errorMessage(error, "Connection failed")}</p>}
    {sections.installed.length === 0 && <p className="wallet-get">No browser wallet found. Get one: {GET_A_WALLET.map((wallet, index) => <span key={wallet.name}>{index > 0 && " · "}<a href={wallet.url} target="_blank" rel="noreferrer">{wallet.name}</a></span>)}</p>}
  </dialog>;
}
