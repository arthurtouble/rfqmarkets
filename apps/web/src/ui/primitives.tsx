import type { ReactNode } from "react";
import type { StreamStatus } from "../lib/event-stream.js";
import type { Market } from "../lib/types.js";

export const AssetIcon = ({ market }: { market: Market }) =>
  <span className={`asset-icon ${market.toLowerCase()}`} aria-hidden="true">{market === "BTC" ? "₿" : "Ξ"}</span>;

export const LiveBadge = ({ status }: { status: StreamStatus }) =>
  <span className={`live-badge ${status}`}>{status === "live" ? "Live" : status === "connecting" ? "Connecting" : "Reconnecting"}</span>;

export function Tabs<T extends string>({ tabs, value, onChange, label }: { tabs: Array<{ id: T; label: ReactNode }>; value: T; onChange: (id: T) => void; label: string }) {
  return <div className="tabs" role="tablist" aria-label={label}>
    {tabs.map(tab => <button key={tab.id} type="button" role="tab" aria-selected={tab.id === value} className={tab.id === value ? "active" : ""} onClick={() => onChange(tab.id)}>{tab.label}</button>)}
  </div>;
}

export const Stat = ({ label, children, tone }: { label: ReactNode; children: ReactNode; tone?: "positive" | "negative" | "" }) =>
  <div className="stat"><small>{label}</small><strong className={`mono ${tone ?? ""}`}>{children}</strong></div>;

export const toneOf = (value: string | bigint) => (BigInt(value) > 0n ? "positive" : BigInt(value) < 0n ? "negative" : "");

export const Empty = ({ children }: { children: ReactNode }) => <p className="empty">{children}</p>;
