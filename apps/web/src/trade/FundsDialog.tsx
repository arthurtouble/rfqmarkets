import { createContext, useContext, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { parseAbi, type Address } from "viem";
import { useConfig } from "wagmi";
import { getPublicClient } from "wagmi/actions";
import { useAccount } from "../account/useAccount.js";
import { useTrading } from "../data/actions.js";
import { keys, useWalletUsdc } from "../data/queries.js";
import { microToInput, parseUsdcInput, usdc } from "../lib/format.js";
import { PRESET_PERCENTS, checkFunds, presetAmount, type FundsMode } from "../lib/funds.js";
import { Banner, Segmented, Sheet } from "../ui/primitives.js";
import { useTrader } from "../wallet/trader.js";

export type { FundsMode };
const registryAbi = parseAbi(["function accountRegistered(address account) view returns (bool)"]);
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

/** Whether the clearing contract knows this account (its first deposit has a 10 USDC floor) and the wallet's gas balance. */
function useDepositChecks(enabled: boolean) {
  const config = useConfig(), { address, chain, settlement, source } = useTrader();
  const clearing = settlement?.clearingAddress;
  const reader = () => {
    const client = getPublicClient(config, { chainId: chain.id });
    if (!client) throw new Error("No RPC for the settlement chain");
    return client;
  };
  const registered = useQuery({
    queryKey: [...keys.account(address ?? ""), "registered", clearing],
    queryFn: () => reader().readContract({ address: clearing!, abi: registryAbi, functionName: "accountRegistered", args: [address as Address] }),
    enabled: enabled && !!address && !!clearing,
  });
  const gas = useQuery({
    queryKey: [...keys.account(address ?? ""), "gas", chain.id],
    queryFn: () => reader().getBalance({ address: address as Address }),
    // The local dev key is funded with ETH; only real wallets need the hint.
    enabled: enabled && !!address && source === "wallet",
  });
  return { registered: registered.data ?? null, gasBalance: gas.data ?? null };
}

function FundsForm({ mode, onMode, onDone }: { mode: FundsMode; onMode: (mode: FundsMode) => void; onDone: () => void }) {
  const trading = useTrading(), walletUsdc = useWalletUsdc(), trader = useTrader();
  const { account } = useAccount();
  const deposit = useDepositChecks(mode === "deposit");
  const [amount, setAmount] = useState("");
  const micro = parseUsdcInput(amount);
  const check = checkFunds({ mode, amount: micro, walletUsdc: walletUsdc.data ?? null, account, ...deposit });
  const busy = trading.busy !== null;
  const switchMode = (next: FundsMode) => { setAmount(""); onMode(next); };
  const submit = async () => {
    if (!micro || check.problem) return;
    const done = mode === "deposit" ? await trading.deposit(micro) : await trading.withdraw(micro);
    if (done) onDone();
  };
  const verb = mode === "deposit" ? "Deposit" : "Withdraw";
  const label = !trader.address ? "Connect a wallet first"
    : busy ? "Confirm in your wallet"
    : !amount ? "Enter an amount"
    : micro === null ? "Enter a valid amount"
    : check.problem ?? `${verb} ${usdc(micro)}`;
  const error = check.problem !== null;

  return <div className="sheet-body">
    <Segmented label="Funds action" value={mode} onChange={switchMode} options={[{ id: "deposit", label: "Deposit" }, { id: "withdraw", label: "Withdraw" }]} />
    <div className="rfq-amount">
      <label className={`rfq-amount__field${error ? " is-error" : ""}`}>
        <span className="rfq-amount__prefix">$</span>
        <input id="funds-amount" autoFocus inputMode="decimal" placeholder="0" autoComplete="off" aria-label="Amount in USDC" value={amount}
          aria-invalid={error || undefined} aria-describedby="funds-meta" disabled={busy}
          onChange={event => /^\d*\.?\d{0,6}$/.test(event.target.value) && setAmount(event.target.value)} />
        <span className="rfq-amount__unit">USDC</span>
      </label>
      <div className="rfq-chips">
        {PRESET_PERCENTS.map(percent => <button key={percent} type="button" className="rfq-chip" disabled={!check.max || busy}
          onClick={() => setAmount(microToInput(presetAmount(check.max, percent)))}>{percent === 100 ? "Max" : `${percent}%`}</button>)}
      </div>
      <div id="funds-meta" className={`rfq-amount__meta${error ? " is-error" : ""}`} aria-live="polite">
        <span>{mode === "deposit" ? "In your wallet" : "Available to withdraw"} {check.available === null ? "—" : usdc(check.available)}</span>
      </div>
    </div>
    {check.warning && <Banner tone="warning">{check.warning}. Add a little before you deposit.</Banner>}
    <p className="footnote rfq-muted sheet-note">{mode === "deposit"
      ? "Moves USDC on Base from your wallet into your trading balance. The first time, your wallet asks you to approve USDC, then to confirm the deposit."
      : "Sends free funds back to your wallet. You sign once and we pay the gas. Funds backing open positions stay put."}</p>
    <button type="button" className="rfq-btn rfq-btn--lg rfq-btn--primary rfq-btn--block" disabled={!trader.address || !micro || error || busy} onClick={submit}>
      {busy && <span className="rfq-spinner" />}{label}
    </button>
  </div>;
}
