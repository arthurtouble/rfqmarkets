import { useEffect, useRef, type ReactNode } from "react";
import type { StreamStatus } from "../lib/event-stream.js";
import type { Market } from "../lib/types.js";

export const MARKET_NAMES: Record<Market, string> = { BTC: "Bitcoin", ETH: "Ethereum" };

export const AssetIcon = ({ market, small = false }: { market: Market; small?: boolean }) =>
  <span className={`rfq-coin rfq-coin--${market.toLowerCase()}${small ? " rfq-coin--sm" : ""}`} aria-hidden="true">{market === "BTC" ? "₿" : "Ξ"}</span>;

export const Up = () => <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M6 2l4 6H2z" fill="currentColor" /></svg>;
export const Down = () => <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M6 10L2 4h8z" fill="currentColor" /></svg>;
export const Chevron = () => <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path d="M5 6l3 3 3-3" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>;
export const Close = () => <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /></svg>;
export const Check = () => <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path d="M3 8.5l3 3 7-7" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>;
export const Warn = () => <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true"><path d="M10 3l8 14H2z" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" /><path d="M10 8v4M10 14.5v.1" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" /></svg>;
export const Info = () => <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="8" fill="none" stroke="currentColor" strokeWidth="1.8" /><path d="M10 9v5M10 6.2v.1" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" /></svg>;

const path = (d: ReactNode) => <svg viewBox="0 0 24 24" aria-hidden="true">{d}</svg>;
const stroke = { fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round" } as const;
export const NavIcons = {
  trade: path(<path d="M4 16l5-5 4 4 7-7" {...stroke} />),
  markets: path(<path d="M5 7h14M5 12h14M5 17h9" {...stroke} />),
  portfolio: path(<><rect x="4" y="6" width="16" height="13" rx="3" {...stroke} /><path d="M9 6V5a3 3 0 016 0v1" {...stroke} /></>),
  account: path(<><circle cx="12" cy="9" r="4" {...stroke} /><path d="M5 20c1.5-3.5 4-5 7-5s5.5 1.5 7 5" {...stroke} /></>),
};

/** A signed change with an arrow, coloured by direction. */
export function Change({ value, children }: { value: number | bigint; children: ReactNode }) {
  const up = value > 0, down = value < 0;
  return <span className={`rfq-change ${up ? "is-up" : down ? "is-down" : ""}`}>{up ? <Up /> : down ? <Down /> : null}{children}</span>;
}

export function StreamBadge({ status }: { status: StreamStatus }) {
  if (status === "live") return null;
  return <span className="rfq-badge rfq-badge--warning"><span className="rfq-dot" />{status === "connecting" ? "Connecting to prices" : "Price delayed"}</span>;
}

/** Segmented control for two to five options. */
export function Segmented<T extends string>({ options, value, onChange, label, className = "", variant = "seg" }: { options: Array<{ id: T; label: ReactNode; disabled?: boolean }>; value: T | null; onChange: (id: T) => void; label: string; className?: string; variant?: "seg" | "switch" }) {
  return <div className={`rfq-${variant} ${className}`} role="group" aria-label={label}>
    {options.map(option => <button key={option.id} type="button" aria-pressed={option.id === value} disabled={option.disabled} onClick={() => onChange(option.id)}>{option.label}</button>)}
  </div>;
}

/** Underline tabs for switching between content sections. */
export function Tabs<T extends string>({ tabs, value, onChange, label }: { tabs: Array<{ id: T; label: ReactNode; count?: number }>; value: T; onChange: (id: T) => void; label: string }) {
  return <div className="rfq-tabs" role="tablist" aria-label={label}>
    {tabs.map(tab => <button key={tab.id} type="button" role="tab" aria-selected={tab.id === value} onClick={() => onChange(tab.id)}>
      {tab.label}{tab.count ? <span className="rfq-count">{tab.count}</span> : null}
    </button>)}
  </div>;
}

export function EmptyState({ icon = NavIcons.trade, children, action }: { icon?: ReactNode; children: ReactNode; action?: ReactNode }) {
  return <div className="rfq-empty"><span className="rfq-empty__icon">{icon}</span><p>{children}</p>{action}</div>;
}

export function Banner({ tone = "info", children, action }: { tone?: "info" | "warning" | "danger"; children: ReactNode; action?: ReactNode }) {
  return <div className={`rfq-banner${tone === "info" ? "" : ` rfq-banner--${tone}`}`} role={tone === "info" ? undefined : "alert"}>
    <span className="rfq-banner__icon">{tone === "info" ? <Info /> : <Warn />}</span><span className="banner-body">{children}</span>{action}
  </div>;
}

export const Rows = ({ rows, className = "" }: { rows: Array<[ReactNode, ReactNode, string?]>; className?: string }) =>
  <dl className={`rfq-dl ${className}`}>{rows.map(([label, value, rowClass], index) => <div key={index} className={rowClass}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>;

/**
 * A bottom sheet on phones and a centered dialog on desktop, built on <dialog>
 * so focus, Escape and the backdrop come from the browser.
 */
export function Sheet({ open, onClose, title, children, labelledBy }: { open: boolean; onClose: () => void; title: ReactNode; children: ReactNode; labelledBy: string }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (open && !element.open) element.showModal();
    if (!open && element.open) element.close();
  }, [open]);
  return <dialog ref={dialog} className="sheet" onClose={onClose} aria-labelledby={labelledBy}
    onClick={event => { if (event.target === dialog.current) onClose(); }}>
    <div className="rfq-sheet">
      <span className="rfq-sheet__grabber" aria-hidden="true" />
      <div className="rfq-sheet__head"><h2 id={labelledBy} className="title-2">{title}</h2><button type="button" className="rfq-icon-btn" aria-label="Close" onClick={onClose}><Close /></button></div>
      {open && children}
    </div>
  </dialog>;
}
