// Small presentational pieces built from the design system's rfq- classes.
import { useEffect, useState, type ReactNode } from "react";

export const InfoIcon = () => <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="8" fill="none" stroke="currentColor" strokeWidth="1.8" /><path d="M10 9v5M10 6.2v.1" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" /></svg>;
export const WarnIcon = () => <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true"><path d="M10 3l8 14H2z" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" /><path d="M10 8v4M10 14.5v.1" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" /></svg>;
const CheckIcon = () => <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path d="M3 8.5l3 3 7-7" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>;
const CrossIcon = () => <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /></svg>;
export const WalletIcon = () => <svg width="24" height="24" viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="6" width="18" height="13" rx="3" fill="none" stroke="currentColor" strokeWidth="2" /><path d="M16 12.5h2" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /><path d="M6 6l9-3 1 3" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" /></svg>;
export const ExternalIcon = () => <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><path d="M6 3H3v10h10v-3M9 3h4v4M13 3L7 9" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>;

export function Banner({ tone = "info", children, action }: { tone?: "info" | "warning" | "danger"; children: ReactNode; action?: ReactNode }) {
  return <div className={`rfq-banner${tone === "info" ? "" : ` rfq-banner--${tone}`}`} role={tone === "info" ? undefined : "alert"}>
    <span className="rfq-banner__icon">{tone === "info" ? <InfoIcon /> : <WarnIcon />}</span>
    <span className="banner-text">{children}</span>
    {action ? <span className="banner-action">{action}</span> : null}
  </div>;
}

export function Card({ title, intro, badge, children, id }: { title: string; intro?: ReactNode; badge?: ReactNode; children: ReactNode; id?: string }) {
  return <section className="rfq-card rfq-card--pad exit-card" aria-labelledby={id ? `${id}-title` : undefined}>
    <div className="exit-card__head">
      <h2 id={id ? `${id}-title` : undefined}>{title}</h2>
      {badge}
    </div>
    {intro ? <p className="exit-card__intro rfq-muted">{intro}</p> : null}
    {children}
  </section>;
}

export const Spinner = () => <span className="rfq-spinner" aria-hidden="true" />;

export function ActionButton({ busy, disabled, onClick, children, tone = "primary", block = true }: { busy?: boolean; disabled?: boolean; onClick: () => void; children: ReactNode; tone?: "primary" | "secondary" | "danger"; block?: boolean }) {
  return <button type="button" className={`rfq-btn rfq-btn--${tone}${block ? " rfq-btn--block" : ""}`} disabled={disabled || busy} aria-busy={busy || undefined} onClick={onClick}>
    {busy ? <Spinner /> : null}{children}
  </button>;
}

export interface ToastState {
  kind: "pending" | "success" | "error";
  title: string;
  body?: string;
  link?: { href: string; label: string };
  /** Unix seconds the oracle price in flight expires; the toast counts down to it. */
  expiresAt?: number;
}

function Countdown({ expiresAt }: { expiresAt: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 500); return () => clearInterval(timer); }, []);
  const left = Math.max(0, Math.ceil(expiresAt - now / 1000));
  return <span className="tnum">{left > 0 ? ` Confirm within ${left}s, while the price is valid.` : " The price has expired; if your wallet still asks, reject it and try again."}</span>;
}

export function Toast({ toast, onClose }: { toast: ToastState | null; onClose: () => void }) {
  return <div className="toast-region" aria-live="polite" aria-atomic="true">
    {toast ? <div className={`rfq-toast rfq-toast--${toast.kind}`} role={toast.kind === "error" ? "alert" : "status"}>
      <span className="rfq-toast__icon">{toast.kind === "pending" ? <Spinner /> : toast.kind === "success" ? <CheckIcon /> : <CrossIcon />}</span>
      <div className="toast-copy">
        <div className="rfq-toast__title">{toast.title}</div>
        {toast.body || toast.expiresAt ? <div className="rfq-toast__body">{toast.body}{toast.expiresAt ? <Countdown expiresAt={toast.expiresAt} /> : null}</div> : null}
        {toast.link ? <a className="rfq-toast__body" href={toast.link.href} target="_blank" rel="noreferrer">{toast.link.label} <ExternalIcon /></a> : null}
      </div>
      {toast.kind !== "pending" ? <button type="button" className="rfq-icon-btn toast-close" aria-label="Dismiss" onClick={onClose}><CrossIcon /></button> : null}
    </div> : null}
  </div>;
}
