// Transient feedback for wallet and settlement actions. A pending toast is
// replaced in place by its result so each action shows exactly one card.
import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from "react";
import { txUrl } from "../lib/explorer.js";
import { useTrader } from "../wallet/trader.js";

export type ToastKind = "pending" | "success" | "error";
export type Toast = { id: number; kind: ToastKind; title: string; detail?: string; txHash?: string };
type Notify = (toast: Omit<Toast, "id">, replaceId?: number) => number;

const ToastContext = createContext<{ notify: Notify; dismiss: (id: number) => void } | null>(null);
const LIFETIME_MS: Record<ToastKind, number> = { pending: 0, success: 6_000, error: 10_000 };

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(1), timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());

  const dismiss = useCallback((id: number) => {
    clearTimeout(timers.current.get(id)); timers.current.delete(id);
    setToasts(current => current.filter(toast => toast.id !== id));
  }, []);

  const notify = useCallback<Notify>((toast, replaceId) => {
    const id = replaceId ?? nextId.current++;
    clearTimeout(timers.current.get(id));
    setToasts(current => [...current.filter(item => item.id !== id), { ...toast, id }].slice(-4));
    const lifetime = LIFETIME_MS[toast.kind];
    if (lifetime) timers.current.set(id, setTimeout(() => dismiss(id), lifetime));
    return id;
  }, [dismiss]);

  return <ToastContext.Provider value={{ notify, dismiss }}>
    {children}
    <ToastStack toasts={toasts} dismiss={dismiss} />
  </ToastContext.Provider>;
}

function ToastStack({ toasts, dismiss }: { toasts: Toast[]; dismiss: (id: number) => void }) {
  const { chain } = useTrader();
  return <div className="toasts" role="status" aria-live="polite">
    {toasts.map(toast => {
      const link = toast.txHash ? txUrl(chain.id, toast.txHash) : undefined;
      return <div key={toast.id} className={`toast ${toast.kind}`}>
        <span className="toast-icon" aria-hidden="true" />
        <div>
          <strong>{toast.title}</strong>
          {toast.detail && <p>{toast.detail}</p>}
          {link && <a href={link} target="_blank" rel="noreferrer">View transaction</a>}
        </div>
        {toast.kind !== "pending" && <button type="button" aria-label="Dismiss" onClick={() => dismiss(toast.id)}>×</button>}
      </div>;
    })}
  </div>;
}

export function useToasts() {
  const value = useContext(ToastContext);
  if (!value) throw new Error("useToasts outside ToastProvider");
  return value;
}
