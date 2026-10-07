import { createContext, useContext, useState, type ReactNode } from "react";
import { useAccount } from "../account/useAccount.js";
import { useTrading } from "../data/actions.js";
import { useWalletUsdc } from "../data/queries.js";
import { microToInput, parseUsdcInput, usdc } from "../lib/format.js";
import { Segmented, Sheet } from "../ui/primitives.js";
import { useTrader } from "../wallet/trader.js";

export type FundsMode = "deposit" | "withdraw";
const FundsContext = createContext<{ open(mode: FundsMode): void } | null>(null);

/** One Deposit / Withdraw sheet for the whole app; anything can open it. */
export function FundsProvider({ children }: { children: ReactNode }) {
  const [mode, setMode] = useState<FundsMode | null>(null);
  return <FundsContext.Provider value={{ open: setMode }}>
    {children}
    <Sheet open={mode !== null} onClose={() => setMode(null)} title={mode === "withdraw" ? "Withdraw" : "Add funds"} labelledBy="funds-title">
      <FundsForm mode={mode ?? "deposit"} onMode={setMode} onDone={() => setMode(null)} />
    </Sheet>
  </FundsContext.Provider>;
}

export function useFunds() {
  const value = useContext(FundsContext);
  if (!value) throw new Error("useFunds outside FundsProvider");
  return value;
}

const PRESETS = [25, 50, 75, 100] as const;

function FundsForm({ mode, onMode, onDone }: { mode: FundsMode; onMode: (mode: FundsMode) => void; onDone: () => void }) {
  const trading = useTrading(), walletUsdc = useWalletUsdc(), trader = useTrader();
  const { account } = useAccount();
  const [amount, setAmount] = useState("");
  const micro = parseUsdcInput(amount);
  const available = mode === "deposit" ? walletUsdc.data ?? null : account ? BigInt(account.availableMargin) : null;
  const ceiling = available !== null && available > 0n ? available : 0n;
  const tooMuch = micro !== null && available !== null && micro > available;
  const busy = trading.busy !== null;
  const switchMode = (next: FundsMode) => { setAmount(""); onMode(next); };
  const submit = async () => {
    if (!micro) return;
    const done = mode === "deposit" ? await trading.deposit(micro) : await trading.withdraw(micro);
    if (done) onDone();
  };
  const label = !trader.address ? "Connect a wallet first"
    : !amount ? "Enter an amount"
    : micro === null ? "Enter a valid amount"
    : tooMuch ? (mode === "deposit" ? "More than your wallet holds" : "More than you can withdraw")
    : busy ? "Confirm in your wallet"
    : `${mode === "deposit" ? "Deposit" : "Withdraw"} ${usdc(micro)}`;

  return <div className="sheet-body">
    <Segmented label="Funds action" value={mode} onChange={switchMode} options={[{ id: "deposit", label: "Deposit" }, { id: "withdraw", label: "Withdraw" }]} />
    <div className="rfq-amount">
      <label className={`rfq-amount__field${tooMuch ? " is-error" : ""}`}>
        <span className="rfq-amount__prefix">$</span>
        <input id="funds-amount" autoFocus inputMode="decimal" placeholder="0" autoComplete="off" aria-label="Amount in USDC" value={amount}
          onChange={event => /^\d*\.?\d*$/.test(event.target.value) && setAmount(event.target.value)} />
        <span className="rfq-amount__unit">USDC</span>
      </label>
      <div className="rfq-chips">
        {PRESETS.map(step => <button key={step} type="button" className="rfq-chip" aria-pressed={false} disabled={!ceiling}
          onClick={() => setAmount(microToInput(ceiling * BigInt(step) / 100n))}>{step === 100 ? "Max" : `${step}%`}</button>)}
      </div>
      <div className={`rfq-amount__meta${tooMuch ? " is-error" : ""}`}>
        <span>{mode === "deposit" ? "In your wallet" : "Available to withdraw"} {available === null ? "—" : usdc(available)}</span>
      </div>
    </div>
    <p className="footnote rfq-muted sheet-note">{mode === "deposit"
      ? "Moves USDC on Base from your wallet into your trading balance. Your wallet asks you to approve USDC first, then to confirm the deposit."
      : "Sends free funds back to your wallet. You sign once and we pay the gas. Funds backing open positions stay put."}</p>
    <button type="button" className="rfq-btn rfq-btn--lg rfq-btn--primary rfq-btn--block" disabled={!trader.address || !micro || tooMuch || busy} onClick={submit}>
      {busy && <span className="rfq-spinner" />}{label}
    </button>
  </div>;
}
