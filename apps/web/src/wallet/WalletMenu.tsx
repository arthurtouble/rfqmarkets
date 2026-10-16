import { Link } from "@tanstack/react-router";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { useConnect, useConnectors } from "wagmi";
import { addressUrl } from "../lib/explorer.js";
import { useAccountValue } from "../account/useAccount.js";
import { shortAddress, usdc } from "../lib/format.js";
import { useTrading } from "../data/actions.js";
import { Check } from "../ui/primitives.js";
import { ConnectDialog } from "./ConnectDialog.js";
import { SwitchNetworkButton } from "./SwitchNetwork.js";
import { useTrader } from "./trader.js";
import { walletLabel, walletSections } from "./wallets.js";

/**
 * The header's connect button, or the account button with its popover once a wallet is connected. The popover
 * holds plain buttons and links (Tab moves through them); Escape or a click outside closes it, and Escape
 * returns focus to the account button.
 */
export function WalletMenu({
  className = "",
  connectLabel = "Connect",
}: {
  className?: string;
  connectLabel?: string;
}) {
  const trader = useTrader();
  // The same account value as Home and Portfolio (the balance plus open Home trades).
  const { value } = useAccountValue();
  const { quickSession } = useTrading();
  const connectors = useConnectors();
  const { mutate: connect } = useConnect();
  const [open, setOpen] = useState(false);
  const [picking, setPicking] = useState(false);
  const [copied, setCopied] = useState(false);
  const closePicker = useCallback(() => setPicking(false), []);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const popover = useRef<HTMLDivElement>(null);
  const popoverId = useId();

  useEffect(() => {
    if (!open) return;
    // Keyboard users land on the first action; Tab moves on from there.
    popover.current?.querySelector<HTMLElement>("button, a[href]")?.focus({ preventScroll: true });
    const close = (event: MouseEvent | KeyboardEvent) => {
      if (event instanceof KeyboardEvent) {
        if (event.key !== "Escape") return;
        setOpen(false);
        trigger.current?.focus();
      } else if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", close);
    };
  }, [open]);
  useEffect(() => {
    setOpen(false);
  }, [trader.address]);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1_500);
    return () => clearTimeout(timer);
  }, [copied]);

  if (!trader.address) {
    return (
      <div className="wallet-menu">
        <button
          type="button"
          className={`rfq-btn rfq-btn--primary ${className}`}
          aria-haspopup="dialog"
          onClick={() => setPicking(true)}
        >
          {connectLabel}
        </button>
        <ConnectDialog open={picking} onClose={closePicker} />
      </div>
    );
  }

  const address = trader.address;
  const sections = walletSections(connectors, true);
  const switchable = [...sections.installed, ...sections.passkey, ...sections.remote];
  const explorer = addressUrl(trader.chain.id, address);
  const walletName = trader.source === "dev" ? "Local dev wallet" : (trader.wallet?.name ?? "Wallet");
  const copy = () => {
    void navigator.clipboard?.writeText(address).then(
      () => setCopied(true),
      () => undefined,
    );
  };
  return (
    <div className="wallet-menu" ref={root}>
      {trader.wrongChain && <SwitchNetworkButton className={className} />}
      <button
        ref={trigger}
        type="button"
        className={`rfq-account-btn ${trader.wrongChain ? "wallet-btn--compact" : ""} ${className}`}
        aria-expanded={open}
        aria-controls={open ? popoverId : undefined}
        aria-label={`Account ${shortAddress(address)}`}
        onClick={() => setOpen((value) => !value)}
      >
        <span className={`rfq-avatar ${trader.source === "dev" ? "dev" : ""}`} aria-hidden="true" />
        <span className="wallet-btn__label">{value !== null ? usdc(value) : shortAddress(address)}</span>
      </button>
      {open && (
        <div className="wallet-popover" id={popoverId} ref={popover} role="group" aria-label="Account">
          <div className="wallet-identity">
            {trader.wallet?.icon ? (
              <img src={trader.wallet.icon} alt="" width={32} height={32} />
            ) : (
              <span className={`rfq-avatar ${trader.source === "dev" ? "dev" : ""}`} aria-hidden="true" />
            )}
            <div>
              <strong className="mono-addr">{shortAddress(address)}</strong>
              <span className="footnote rfq-muted">
                {walletName} · {trader.wrongChain ? "wrong network" : trader.chain.name}
              </span>
            </div>
          </div>
          <button type="button" onClick={copy}>
            {copied ? (
              <>
                Copied <Check />
              </>
            ) : (
              "Copy address"
            )}
          </button>
          {explorer && (
            <a href={explorer} target="_blank" rel="noreferrer">
              View on explorer
            </a>
          )}
          <Link to="/account" onClick={() => setOpen(false)}>
            Account settings{quickSession?.privateKey && <span className="wallet-badge">One tap on</span>}
          </Link>
          {trader.source === "dev" &&
            switchable.map((connector) => (
              <button
                key={connector.uid}
                type="button"

                onClick={() => connect({ connector, chainId: trader.chain.id })}
              >
                Use {walletLabel(connector)}
              </button>
            ))}
          <button
            type="button"

            className="danger"
            onClick={() => {
              trader.disconnect();
              setOpen(false);
            }}
          >
            Disconnect
          </button>
        </div>
      )}
    </div>
  );
}
