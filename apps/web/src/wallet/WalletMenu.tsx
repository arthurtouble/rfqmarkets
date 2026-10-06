import { useEffect, useRef, useState } from "react";
import { useConnect, useConnectors, useSwitchChain, type Connector } from "wagmi";
import { addressUrl } from "../lib/explorer.js";
import { errorMessage } from "../lib/http.js";
import { shortAddress } from "../lib/format.js";
import { useTrader } from "./trader.js";

/** EIP-6963 wallets announce themselves; hide the generic fallback when any did. */
function visibleConnectors(connectors: readonly Connector[]) {
  const announced = connectors.filter(connector => connector.id !== "injected");
  return announced.length ? announced : connectors;
}

export function WalletMenu({ className = "" }: { className?: string }) {
  const trader = useTrader();
  const connectors = useConnectors();
  const { mutate: connect, isPending, error, reset } = useConnect();
  const { mutate: switchChain, isPending: switching } = useSwitchChain();
  const [open, setOpen] = useState(false);
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
    return <button type="button" className={`wallet-button warn ${className}`} disabled={switching} onClick={() => switchChain({ chainId: trader.chain.id })}>
      {switching ? "Switching…" : `Switch to ${trader.chain.name}`}
    </button>;
  }

  const list = visibleConnectors(connectors);
  const explorer = trader.address ? addressUrl(trader.chain.id, trader.address) : undefined;
  return <div className="wallet-menu" ref={root}>
    <button type="button" className={`wallet-button ${trader.address ? "connected" : ""} ${className}`} aria-haspopup="menu" aria-expanded={open} onClick={() => { reset(); setOpen(value => !value); }}>
      {trader.address ? <><i className={`wallet-dot ${trader.source}`} />{shortAddress(trader.address)}</> : "Connect wallet"}
    </button>
    {open && <div className="wallet-popover" role="menu">
      {trader.address ? <>
        <div className="wallet-identity">
          <small>{trader.source === "dev" ? "Local dev wallet" : "Connected"} · {trader.chain.name}</small>
          <strong className="mono">{shortAddress(trader.address)}</strong>
        </div>
        <button type="button" role="menuitem" onClick={() => { void navigator.clipboard?.writeText(trader.address!); setOpen(false); }}>Copy address</button>
        {explorer && <a role="menuitem" href={explorer} target="_blank" rel="noreferrer">View on explorer</a>}
        {trader.source === "dev" && list.map(connector => <button key={connector.uid} type="button" role="menuitem" onClick={() => connect({ connector, chainId: trader.chain.id })}>Use {connector.name}</button>)}
        <button type="button" role="menuitem" className="danger" onClick={() => { trader.disconnect(); setOpen(false); }}>Disconnect</button>
      </> : <>
        <div className="wallet-identity"><small>Connect to trade on {trader.chain.name}</small></div>
        {list.map(connector => <button key={connector.uid} type="button" role="menuitem" disabled={isPending} onClick={() => connect({ connector, chainId: trader.chain.id })}>
          {connector.icon && <img src={connector.icon} alt="" width={18} height={18} />}{connector.id === "injected" ? "Browser wallet" : connector.name}
        </button>)}
        {trader.devWalletAvailable && <button type="button" role="menuitem" onClick={trader.useDevWallet}>Local dev wallet</button>}
        {!list.length && !trader.devWalletAvailable && <p className="wallet-hint">No browser wallet found. Install one such as Rabby, MetaMask or Coinbase Wallet.</p>}
        {error && <p className="wallet-hint error">{errorMessage(error, "Connection failed")}</p>}
      </>}
    </div>}
  </div>;
}
