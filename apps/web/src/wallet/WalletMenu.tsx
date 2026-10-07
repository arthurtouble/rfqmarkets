import { Link } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { useConnect, useConnectors } from "wagmi";
import { addressUrl } from "../lib/explorer.js";
import { useAccount } from "../account/useAccount.js";
import { shortAddress, usdc } from "../lib/format.js";
import { useTrading } from "../data/actions.js";
import { Check } from "../ui/primitives.js";
import { ConnectDialog } from "./ConnectDialog.js";
import { SwitchNetworkButton } from "./SwitchNetwork.js";
import { useTrader } from "./trader.js";
import { walletLabel, walletSections } from "./wallets.js";

/** The header's connect button, or the account button with its menu once a wallet is connected. */
export function WalletMenu({ className = "", connectLabel = "Connect" }: { className?: string; connectLabel?: string }) {
  const trader = useTrader();
  const { account } = useAccount();
  const { quickSession } = useTrading();
  const connectors = useConnectors();
  const { mutate: connect } = useConnect();
  const [open, setOpen] = useState(false);
  const [picking, setPicking] = useState(false);
  const [copied, setCopied] = useState(false);
  const closePicker = useCallback(() => setPicking(false), []);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent | KeyboardEvent) => {
      if (event instanceof KeyboardEvent ? event.key === "Escape" : !root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close); document.addEventListener("keydown", close);
    return () => { document.removeEventListener("mousedown", close); document.removeEventListener("keydown", close); };
  }, [open]);
  useEffect(() => { setOpen(false); }, [trader.address]);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1_500);
    return () => clearTimeout(timer);
  }, [copied]);

  if (!trader.address) {
    return <div className="wallet-menu">
      <button type="button" className={`rfq-btn rfq-btn--primary ${className}`} aria-haspopup="dialog" onClick={() => setPicking(true)}>{connectLabel}</button>
      <ConnectDialog open={picking} onClose={closePicker} />
    </div>;
  }

  const address = trader.address;
  const sections = walletSections(connectors, true);
  const switchable = [...sections.installed, ...sections.passkey, ...sections.remote];
  const explorer = addressUrl(trader.chain.id, address);
  const walletName = trader.source === "dev" ? "Local dev wallet" : trader.wallet?.name ?? "Wallet";
  const copy = () => { void navigator.clipboard?.writeText(address).then(() => setCopied(true), () => undefined); };
  return <div className="wallet-menu" ref={root}>
    {trader.wrongChain && <SwitchNetworkButton className={className} />}
    <button type="button" className={`rfq-account-btn ${trader.wrongChain ? "wallet-btn--compact" : ""} ${className}`} aria-haspopup="menu" aria-expanded={open} aria-label={`Account ${shortAddress(address)}`} onClick={() => setOpen(value => !value)}>
      <span className={`rfq-avatar ${trader.source === "dev" ? "dev" : ""}`} aria-hidden="true" /><span className="wallet-btn__label">{account ? usdc(account.equity) : shortAddress(address)}</span>
    </button>
    {open && <div className="wallet-popover" role="menu" aria-label="Account">
      <div className="wallet-identity">
        {trader.wallet?.icon ? <img src={trader.wallet.icon} alt="" width={32} height={32} /> : <span className={`rfq-avatar ${trader.source === "dev" ? "dev" : ""}`} aria-hidden="true" />}
        <div>
          <strong className="mono-addr">{shortAddress(address)}</strong>
          <span className="footnote rfq-muted">{walletName} · {trader.wrongChain ? "wrong network" : trader.chain.name}</span>
        </div>
      </div>
      <button type="button" role="menuitem" onClick={copy}>{copied ? <>Copied <Check /></> : "Copy address"}</button>
      {explorer && <a role="menuitem" href={explorer} target="_blank" rel="noreferrer">View on explorer</a>}
      <Link role="menuitem" to="/account" onClick={() => setOpen(false)}>
        Account settings{quickSession?.privateKey && <span className="wallet-badge">One-click on</span>}
      </Link>
      {trader.source === "dev" && switchable.map(connector => <button key={connector.uid} type="button" role="menuitem" onClick={() => connect({ connector, chainId: trader.chain.id })}>Use {walletLabel(connector)}</button>)}
      <button type="button" role="menuitem" className="danger" onClick={() => { trader.disconnect(); setOpen(false); }}>Disconnect</button>
    </div>}
  </div>;
}
