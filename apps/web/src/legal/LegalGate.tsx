import { useCallback, useEffect, useRef, useState } from "react";
import { GEO_URL, LEGAL_LINKS } from "../lib/env.js";
import { TERMS_KEY, hasAccepted, parseLocation, withAcceptance, type LocationStatus } from "../lib/legal.js";
import { Banner, EmptyState } from "../ui/primitives.js";
import { useTrader } from "../wallet/trader.js";

const readTerms = () => { try { return localStorage.getItem(TERMS_KEY); } catch { return null; } };

/** The edge's view of where this visitor is. "unknown" until it answers, and if it never does. */
export function useLocationStatus() {
  const [location, setLocation] = useState<{ status: LocationStatus; message: string | null }>({ status: "unknown", message: null });
  useEffect(() => {
    if (!GEO_URL) return;
    const controller = new AbortController();
    fetch(GEO_URL, { signal: controller.signal, cache: "no-store" })
      .then(response => (response.ok ? response.json() : null))
      .then(body => setLocation(parseLocation(body)))
      .catch(() => { /* the edge still enforces; the app just cannot explain it */ });
    return () => controller.abort();
  }, []);
  return location;
}

const PolicyLink = ({ href, children }: { href: string; children: string }) => <a href={href} target="_blank" rel="noreferrer">{children}</a>;

/** Shown instead of the app where the venue is sanctioned: every service call is refused there anyway. */
export function UnavailableHere({ message }: { message: string | null }) {
  return <section className="legal-unavailable" aria-labelledby="unavailable-title">
    <EmptyState action={<PolicyLink href={LEGAL_LINKS.jurisdictions}>Restricted jurisdictions</PolicyLink>}>
      <strong id="unavailable-title">Not available in your location</strong>
      <br />
      {message ?? "RFQ Markets is not available in your location."}
    </EmptyState>
  </section>;
}

/** Restricted locations keep exits: closing, cancelling and withdrawing. */
export function RestrictedNotice({ message }: { message: string | null }) {
  return <div className="legal-notice">
    <Banner tone="warning" action={<PolicyLink href={LEGAL_LINKS.jurisdictions}>Why</PolicyLink>}>
      {message ?? "Opening or increasing positions is not available in your location. You can still close positions, cancel orders and withdraw."}
    </Banner>
  </div>;
}

const STATEMENTS = [
  { id: "location", text: "I am not a resident of, located in or incorporated in the United States or any other restricted jurisdiction, and I am not using a VPN or similar tool to hide where I am." },
  { id: "sanctions", text: "I am not a sanctioned person and I am not acting for one." },
  { id: "risk", text: "I understand that perpetual futures are leveraged, that this venue is in development with unaudited contracts, and that I can lose everything I deposit." },
] as const;

/** Asks each connected wallet to accept the current terms once. Declining disconnects. */
export function TermsDialog() {
  const trader = useTrader();
  const dialog = useRef<HTMLDialogElement>(null);
  const [stored, setStored] = useState(readTerms);
  const [checked, setChecked] = useState<Record<string, boolean>>({});
  const account = trader.address;
  const open = Boolean(account) && !hasAccepted(stored, account ?? "");

  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (open && !element.open) { setChecked({}); element.showModal(); }
    if (!open && element.open) element.close();
  }, [open]);

  const accept = useCallback(() => {
    if (!account) return;
    const next = withAcceptance(readTerms(), account, Date.now());
    try { localStorage.setItem(TERMS_KEY, next); } catch { /* private mode: ask again next visit */ }
    setStored(next);
  }, [account]);

  const all = STATEMENTS.every(statement => checked[statement.id]);
  // Escape would leave a connected wallet that never accepted; treat it as declining.
  return <dialog ref={dialog} className="dialog terms-dialog" aria-labelledby="terms-title" onCancel={event => { event.preventDefault(); trader.disconnect(); }}>
    <header><h2 id="terms-title">Before you trade</h2></header>
    <p className="dialog-copy">
      Please confirm the following. By continuing you agree to the <PolicyLink href={LEGAL_LINKS.terms}>Terms of Service</PolicyLink> and <PolicyLink href={LEGAL_LINKS.privacy}>Privacy Policy</PolicyLink>, and confirm you have read the <PolicyLink href={LEGAL_LINKS.risk}>Risk Disclosure</PolicyLink>.
    </p>
    <div className="terms-checks">
      {STATEMENTS.map(statement => <label key={statement.id} className="terms-check">
        <input type="checkbox" checked={Boolean(checked[statement.id])} onChange={event => setChecked(current => ({ ...current, [statement.id]: event.target.checked }))} />
        <span>{statement.text}{statement.id === "location" && <> See <PolicyLink href={LEGAL_LINKS.jurisdictions}>restricted jurisdictions</PolicyLink>.</>}</span>
      </label>)}
    </div>
    <div className="terms-actions">
      <button type="button" className="rfq-btn rfq-btn--secondary" onClick={() => trader.disconnect()}>Disconnect</button>
      <button type="button" className="rfq-btn rfq-btn--primary" disabled={!all} onClick={accept}>Agree and continue</button>
    </div>
  </dialog>;
}
