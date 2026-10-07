import { Link } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { useConnect, useConnectors, useSwitchChain } from "wagmi";
import { addressUrl } from "../lib/explorer.js";
import { useAccount } from "../account/useAccount.js";
import { shortAddress, usdc } from "../lib/format.js";
import { Warn } from "../ui/primitives.js";
import { ConnectDialog } from "./ConnectDialog.js";
import { useTrader } from "./trader.js";
import { walletLabel, walletSections } from "./wallets.js";

export function WalletMenu({ className = "", connectLabel = "Connect" }: { className?: string; connectLabel?: string }) {
  const trader = useTrader();
  const { account } = useAccount();
  const connectors = useConnectors();
  const { mutate: connect } = useConnect();
  const { mutate: switchChain, isPending: switching } = useSwitchChain();
  const [open, setOpen] = useState(false);
  const [picking, setPicking] = useState(false);
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
  useEffect(() => { if (trader.address) setOpen(false); }, [trader.address]);

  if (trader.wrongChain) {
    return <button type="button" className={`rfq-btn rfq-btn--sm wallet-warn ${className}`} disabled={switching} onClick={() => switchChain({ chainId: trader.chain.id })}>
      <Warn />{switching ? "Switching…" : `Switch to ${trader.chain.name}`}
    </button>;
  }

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
  return <div className="wallet-menu" ref={root}>
    <button type="button" className={`rfq-account-btn ${className}`} aria-haspopup="menu" aria-expanded={open} aria-label={`Account ${shortAddress(address)}`} onClick={() => setOpen(value => !value)}>
      <span className={`rfq-avatar ${trader.source === "dev" ? "dev" : ""}`} aria-hidden="true" />{account ? usdc(account.equity) : shortAddress(address)}
    </button>
    {open && <div className="wallet-popover" role="menu">
      <div className="wallet-identity">
        <span className="footnote rfq-muted">{trader.source === "dev" ? "Local dev wallet" : "Connected"} · {trader.chain.name}</span>
        <strong className="mono">{shortAddress(address)}</strong>
      </div>
      <button type="button" role="menuitem" onClick={() => { void navigator.clipboard?.writeText(address); setOpen(false); }}>Copy address</button>
      {explorer && <a role="menuitem" href={explorer} target="_blank" rel="noreferrer">View on explorer</a>}
      <Link role="menuitem" to="/account" onClick={() => setOpen(false)}>Settings</Link>
      {trader.source === "dev" && switchable.map(connector => <button key={connector.uid} type="button" role="menuitem" onClick={() => connect({ connector, chainId: trader.chain.id })}>Use {walletLabel(connector)}</button>)}
      <button type="button" role="menuitem" className="danger" onClick={() => { trader.disconnect(); setOpen(false); }}>Disconnect</button>
    </div>}
  </div>;
}
