import { useEffect, useRef, useState } from "react";
import { useTrading } from "../data/actions.js";
import { useWalletUsdc } from "../data/queries.js";
import { microToInput, parseUsdcInput, usdc } from "../lib/format.js";
import type { AccountState } from "../lib/types.js";
import { Tabs } from "../ui/primitives.js";

export type FundsMode = "deposit" | "withdraw";

export function FundsDialog({ mode, onMode, onClose, account }: { mode: FundsMode | null; onMode: (mode: FundsMode) => void; onClose: () => void; account: AccountState | null }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const trading = useTrading(), walletUsdc = useWalletUsdc();
  const [amount, setAmount] = useState("");
  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (mode && !element.open) element.showModal();
    if (!mode && element.open) element.close();
  }, [mode]);
  useEffect(() => setAmount(""), [mode]);

  const micro = parseUsdcInput(amount);
  const available = mode === "deposit" ? walletUsdc.data ?? null : account ? BigInt(account.availableMargin) : null;
  const ceiling = available !== null && available > 0n ? available : 0n;
  const tooMuch = micro !== null && available !== null && micro > available;
  const submit = async () => {
    if (!micro || !mode) return;
    const done = mode === "deposit" ? await trading.deposit(micro) : await trading.withdraw(micro);
    if (done) onClose();
  };

  return <dialog ref={dialog} className="dialog" onClose={onClose} aria-labelledby="funds-title">
    <header><h2 id="funds-title">Funds</h2><button type="button" className="icon" aria-label="Close" onClick={onClose}>×</button></header>
    <Tabs label="Funds action" value={mode ?? "deposit"} onChange={onMode} tabs={[{ id: "deposit", label: "Deposit" }, { id: "withdraw", label: "Withdraw" }]} />
    <p className="dialog-copy">{mode === "deposit"
      ? "Move native USDC from your wallet into trading collateral. Your wallet asks you to approve USDC, then to confirm the deposit."
      : "Withdraw free collateral to your connected wallet. You sign once and gas is sponsored."}</p>
    <label className="field">
      <span>Amount <small>{mode === "deposit" ? "Wallet balance" : "Available"} {available === null ? "—" : usdc(available)}</small></span>
      <div className="input"><input autoFocus inputMode="decimal" placeholder="0.00" value={amount} onChange={event => /^\d*\.?\d*$/.test(event.target.value) && setAmount(event.target.value)} />
        <button type="button" className="inline" disabled={!ceiling} onClick={() => setAmount(microToInput(ceiling))}>Max</button></div>
    </label>
    {tooMuch && <p className="notice warn">That is more than {mode === "deposit" ? "your wallet holds" : "you can withdraw"}.</p>}
    <button type="button" className="submit primary" disabled={!micro || tooMuch || trading.busy !== null} onClick={submit}>
      {trading.busy ? "Waiting for wallet…" : mode === "deposit" ? "Approve and deposit" : "Sign and withdraw"}
    </button>
  </dialog>;
}
