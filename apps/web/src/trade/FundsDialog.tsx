import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { parseAbi, type Address } from "viem";
import { useConfig } from "wagmi";
import { getPublicClient } from "wagmi/actions";
import { useAccount } from "../account/useAccount.js";
import { useTrading } from "../data/actions.js";
import { loadSentRoute, saveSentRoute, useDebounced, useHoldings, useRoute, useRouteStatus, useSourceBalance, type SentRoute } from "../data/bridge.js";
import { keys, useWalletUsdc } from "../data/queries.js";
import {
  BASE_CHAIN_ID, SOURCE_CHAINS, WARN_ROUTE_LOSS, explorerUrl, formatDuration, formatRate, formatTokenAmount, formatUsd,
  parseTokenInput, routeProblem, sourceChain, type Holding, type SourceToken,
} from "../lib/bridge.js";
import { microToInput, parseUsdcInput, usdc } from "../lib/format.js";
import { MIN_FIRST_DEPOSIT, PRESET_PERCENTS, checkFunds, plainAccount, presetAmount, type FundsMode } from "../lib/funds.js";
import { Banner, Chevron, Rows, Segmented, Sheet } from "../ui/primitives.js";
import { useToasts } from "../ui/toasts.js";
import { useTrader } from "../wallet/trader.js";

export type { FundsMode };
const registryAbi = parseAbi(["function accountRegistered(address account) view returns (bool)"]);
type Opener = { open(mode: FundsMode): void };
const FundsContext = createContext<Opener | null>(null);

/** Where a deposit comes from: USDC already in the Base wallet, or another asset routed through LI.FI. */
type Source = { kind: "usdc" } | { kind: "route"; chainId: number; token: SourceToken };
type Tracking = { sent: SentRoute | null; arrived: { amount: bigint; network: string } | null; dismissArrived(): void };

/** One Deposit / Withdraw sheet for the whole app; anything can open it. */
export function FundsProvider({ children }: { children: ReactNode }) {
  const [mode, setMode] = useState<FundsMode | null>(null);
  const tracking = useRouteTracking(() => setMode("deposit"));
  return <FundsContext.Provider value={{ open: setMode }}>
    {children}
    <Sheet open={mode !== null} onClose={() => setMode(null)} title={mode === "withdraw" ? "Withdraw" : "Add funds"} labelledBy="funds-title">
      <FundsForm mode={mode ?? "deposit"} onMode={setMode} onDone={() => setMode(null)} tracking={tracking} />
    </Sheet>
  </FundsContext.Provider>;
}

export function useFunds() {
  const value = useContext(FundsContext);
  if (!value) throw new Error("useFunds outside FundsProvider");
  return value;
}

/**
 * Follows a sent route until LI.FI reports it delivered (or not), across reloads. When Base USDC
 * arrives the sheet reopens with that amount, ready for the gas-free deposit.
 */
function useRouteTracking(reopen: () => void): Tracking {
  const { address } = useTrader(), { notify } = useToasts();
  const [sent, setSent] = useState<SentRoute | null>(() => loadSentRoute(address));
  const [arrived, setArrived] = useState<Tracking["arrived"]>(null);
  const toast = useRef<number | undefined>(undefined);
  useEffect(() => { setSent(loadSentRoute(address)); setArrived(null); }, [address]);
  useEffect(() => {
    const listener = () => setSent(loadSentRoute(address));
    window.addEventListener("rfq:bridge", listener);
    return () => window.removeEventListener("rfq:bridge", listener);
  }, [address]);
  const status = useRouteStatus(sent);
  useEffect(() => {
    if (!sent || !status.data) return;
    const result = status.data;
    if (result.state === "pending") {
      toast.current = notify({ kind: "pending", title: `Bridging ${sent.sent} from ${sent.network}`, detail: result.detail ?? `Arrives ${formatDuration(sent.durationSeconds)} after sending` }, toast.current);
      return;
    }
    saveSentRoute(null);
    setSent(null);
    if (result.state === "done") {
      notify({ kind: "success", title: `${usdc(result.received)} arrived in your Base wallet`, detail: "Deposit it to start trading" }, toast.current);
      setArrived({ amount: result.received, network: sent.network });
      reopen();
    } else notify({ kind: "error", title: result.state === "failed" ? "Bridge failed" : "Bridge finished differently", detail: result.detail }, toast.current);
    toast.current = undefined;
  }, [status.data, sent]); // eslint-disable-line react-hooks/exhaustive-deps
  return { sent, arrived, dismissArrived: () => setArrived(null) };
}

/** Whether the clearing contract knows this account (its first deposit has a 10 USDC floor), the wallet's gas, and whether it can deposit gas-free. */
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
  const code = useQuery({
    queryKey: [...keys.account(address ?? ""), "code", chain.id],
    queryFn: async () => (await reader().getCode({ address: address as Address })) ?? "0x",
    enabled: enabled && !!address && source === "wallet",
    staleTime: Infinity,
  });
  return {
    registered: registered.data ?? null,
    gasBalance: gas.data ?? null,
    gasFree: source === "dev" ? true : code.data === undefined ? null : plainAccount(code.data),
  };
}

function FundsForm({ mode, onMode, onDone, tracking }: { mode: FundsMode; onMode: (mode: FundsMode) => void; onDone: () => void; tracking: Tracking }) {
  const trader = useTrader();
  const [source, setSource] = useState<Source>({ kind: "usdc" });
  const [picking, setPicking] = useState(false);
  // Routes need a browser wallet and Base, where LI.FI delivers. Local and test chains deposit USDC only.
  const routes = mode === "deposit" && trader.source === "wallet" && trader.chain.id === BASE_CHAIN_ID && !!trader.settlement?.tokenAddress;
  useEffect(() => { if (tracking.arrived) { setSource({ kind: "usdc" }); setPicking(false); } }, [tracking.arrived]);
  const switchMode = (next: FundsMode) => { setPicking(false); onMode(next); };
  const active = routes ? source : { kind: "usdc" as const };

  return <div className="sheet-body">
    <Segmented label="Funds action" value={mode} onChange={switchMode} options={[{ id: "deposit", label: "Deposit" }, { id: "withdraw", label: "Withdraw" }]} />
    {mode === "deposit" && tracking.sent && <Banner>
      Bridging <b>{tracking.sent.sent}</b> from {tracking.sent.network}. About {usdc(tracking.sent.toAmount)} lands in your Base wallet, then you deposit it here. <a href={explorerUrl(tracking.sent.hash)} target="_blank" rel="noreferrer">Track it</a>
    </Banner>}
    {routes && <SourceButton source={active} open={picking} onClick={() => setPicking(!picking)} />}
    {routes && picking
      ? <SourcePicker onPick={next => { setSource(next); setPicking(false); }} />
      : active.kind === "route"
        ? <RouteForm key={`${active.chainId}:${active.token.address}`} chainId={active.chainId} token={active.token} />
        : <UsdcForm mode={mode} onDone={onDone} tracking={mode === "deposit" ? tracking : null} />}
  </div>;
}

const networkName = (chainId: number) => sourceChain(chainId)?.name ?? `chain ${chainId}`;

function TokenBadge({ symbol, logo }: { symbol: string; logo?: string }) {
  return <span className="token-badge" aria-hidden="true">{logo ? <img src={logo} alt="" loading="lazy" referrerPolicy="no-referrer" /> : symbol.slice(0, 1)}</span>;
}

function SourceButton({ source, open, onClick }: { source: Source; open: boolean; onClick: () => void }) {
  const label = source.kind === "usdc" ? "USDC" : source.token.symbol;
  const network = source.kind === "usdc" ? "Base" : networkName(source.chainId);
  return <button type="button" className="source-button" aria-expanded={open} aria-label={`Deposit from ${label} on ${network}. Change`} onClick={onClick}>
    <span className="footnote rfq-muted">From</span>
    <span className="source-button__value"><TokenBadge symbol={label} logo={source.kind === "route" ? source.token.logoURI : undefined} /><b>{label}</b> on {network}</span>
    <Chevron />
  </button>;
}

/** Base USDC first, then what the wallet holds elsewhere (LI.FI's balance index), then any network's common assets. */
function SourcePicker({ onPick }: { onPick: (source: Source) => void }) {
  const holdings = useHoldings(true), walletUsdc = useWalletUsdc();
  const [network, setNetwork] = useState<number | null>(null);
  const chain = network === null ? null : sourceChain(network);
  const row = (key: string, title: ReactNode, sub: ReactNode, end: ReactNode, pick: () => void, logo?: string, symbol = "?") =>
    <button key={key} type="button" className="rfq-row source-row" onClick={pick}>
      <TokenBadge symbol={symbol} logo={logo} />
      <span><span className="source-row__title">{title}</span><span className="rfq-row__sub">{sub}</span></span>
      <span className="rfq-row__end">{end}</span>
    </button>;
  const holdingRow = (holding: Holding) => row(`${holding.chainId}:${holding.address}`, holding.symbol, `on ${networkName(holding.chainId)}`,
    <><span>{formatTokenAmount(holding.amount, holding.decimals, 4)}</span><span className="rfq-row__sub">{formatUsd(holding.usd)}</span></>,
    () => onPick({ kind: "route", chainId: holding.chainId, token: holding }), holding.logoURI, holding.symbol);

  return <div className="source-picker">
    <div className="rfq-list" role="list" aria-label="Your assets">
      {row("usdc", "USDC", "on Base · gas-free, instant", <span>{walletUsdc.data === undefined ? "—" : usdc(walletUsdc.data)}</span>, () => onPick({ kind: "usdc" }), undefined, "USDC")}
      {holdings.isPending && <p className="footnote rfq-muted source-picker__note">Looking for your assets on other networks…</p>}
      {holdings.isError && <p className="footnote rfq-muted source-picker__note">Couldn't list your other assets right now. Pick a network below.</p>}
      {holdings.data?.length === 0 && <p className="footnote rfq-muted source-picker__note">No other assets found in this wallet. Pick a network below.</p>}
      {holdings.data?.slice(0, 12).map(holdingRow)}
    </div>
    <div className="stack">
      <span className="footnote rfq-muted">Or pick a network</span>
      <div className="rfq-chips" role="group" aria-label="Network">
        {SOURCE_CHAINS.map(item => <button key={item.id} type="button" className="rfq-chip" aria-pressed={network === item.id} onClick={() => setNetwork(item.id)}>{item.name}</button>)}
      </div>
      {chain && <div className="rfq-list" role="list" aria-label={`Assets on ${chain.name}`}>
        {chain.tokens.map(token => row(`${chain.id}:${token.address}`, token.symbol, `on ${chain.name}`, null, () => onPick({ kind: "route", chainId: chain.id, token }), token.logoURI, token.symbol))}
      </div>}
    </div>
  </div>;
}

/** Deposits of Base USDC already in the wallet (gas-free where the wallet allows), and withdrawals. */
function UsdcForm({ mode, onDone, tracking }: { mode: FundsMode; onDone: () => void; tracking: Tracking | null }) {
  const trading = useTrading(), walletUsdc = useWalletUsdc(), trader = useTrader();
  const { account } = useAccount();
  const deposit = useDepositChecks(mode === "deposit");
  const arrived = tracking?.arrived ?? null;
  const [amount, setAmount] = useState(() => (arrived ? microToInput(arrived.amount) : ""));
  const input = useRef<HTMLInputElement>(null);
  // The Sheet calls showModal after this form mounts, which moves focus to its first button;
  // focus the amount on the next frame instead (React's autoFocus runs too early here).
  useEffect(() => { const frame = requestAnimationFrame(() => input.current?.focus()); return () => cancelAnimationFrame(frame); }, [mode]);
  useEffect(() => { setAmount(arrived ? microToInput(arrived.amount) : ""); }, [mode, arrived]);
  const micro = parseUsdcInput(amount);
  const check = checkFunds({ mode, amount: micro, walletUsdc: walletUsdc.data ?? null, account, ...deposit });
  const busy = trading.busy !== null;
  const gasFree = mode === "deposit" && deposit.gasFree === true && (micro === null || micro >= 1_000_000n);
  const submit = async () => {
    if (!micro || check.problem) return;
    const done = mode === "deposit" ? await trading.deposit(micro) : await trading.withdraw(micro);
    if (done) { tracking?.dismissArrived(); onDone(); }
  };
  const verb = mode === "deposit" ? "Deposit" : "Withdraw";
  const label = !trader.address ? "Connect a wallet first"
    : busy ? "Confirm in your wallet"
    : !amount ? "Enter an amount"
    : micro === null ? "Enter a valid amount"
    : check.problem ?? `${verb} ${usdc(micro)}`;
  const error = check.problem !== null;

  return <>
    {arrived && <Banner>{usdc(arrived.amount)} arrived from {arrived.network}. Deposit it below to start trading.</Banner>}
    <div className="rfq-amount">
      <label className={`rfq-amount__field${error ? " is-error" : ""}`}>
        <span className="rfq-amount__prefix">$</span>
        <input ref={input} id="funds-amount" inputMode="decimal" placeholder="0" autoComplete="off" aria-label="Amount in USDC" value={amount}
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
    {check.warning && <Banner tone="warning">{check.warning}. Add a little before you deposit, or deposit from another network.</Banner>}
    <p className="footnote rfq-muted sheet-note">{mode === "withdraw"
      ? "Sends free funds back to your wallet. You sign once and we pay the gas. Funds backing open positions stay put."
      : gasFree ? "Moves USDC on Base from your wallet into your trading balance. You sign once and we pay the gas, so you need no ETH."
      : "Moves USDC on Base from your wallet into your trading balance. The first time, your wallet asks you to approve USDC, then to confirm the deposit."}</p>
    <button type="button" className="rfq-btn rfq-btn--lg rfq-btn--primary rfq-btn--block" disabled={!trader.address || !micro || error || busy} onClick={submit}>
      {busy && <span className="rfq-spinner" />}{label}
    </button>
  </>;
}

/** Any asset on a supported network, swapped and bridged by LI.FI into USDC in the user's Base wallet. */
function RouteForm({ chainId, token }: { chainId: number; token: SourceToken }) {
  const trading = useTrading(), trader = useTrader();
  const deposit = useDepositChecks(true);
  const balance = useSourceBalance(chainId, token.address);
  const network = networkName(chainId);
  const [amount, setAmount] = useState("");
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { const frame = requestAnimationFrame(() => input.current?.focus()); return () => cancelAnimationFrame(frame); }, []);
  const units = parseTokenInput(amount, token.decimals);
  const settled = useDebounced(units, 600);
  const over = units !== null && balance.data !== undefined && units > balance.data;
  const request = settled !== null && settled === units && !over && trader.address && trader.settlement?.tokenAddress
    ? { fromChain: chainId, fromToken: token.address, fromAmount: settled, account: trader.address, toToken: trader.settlement.tokenAddress }
    : null;
  const route = useRoute(request, token.decimals);
  const quote = route.data && request && route.data.request.fromAmount === units ? route.data : null;
  const problem = over ? "More than your wallet holds" : quote ? routeProblem(quote, deposit.registered === false, MIN_FIRST_DEPOSIT) : null;
  const busy = trading.busy !== null;
  const loading = units !== null && !over && !quote && !route.isError;

  const submit = async () => {
    if (!quote || problem) return;
    const sent = await trading.bridge(quote, token);
    if (!sent) return;
    const record: SentRoute = {
      account: trader.address!, hash: sent.hash, fromChain: chainId, network,
      sent: `${formatTokenAmount(quote.request.fromAmount, token.decimals, 6)} ${token.symbol}`,
      toAmount: sent.route.toAmount.toString(), durationSeconds: sent.route.durationSeconds, sentAtMs: Date.now(),
    };
    saveSentRoute(record);
    window.dispatchEvent(new Event("rfq:bridge"));
    setAmount("");
  };
  const label = !trader.address ? "Connect a wallet first"
    : busy ? "Confirm in your wallet"
    : !amount ? "Enter an amount"
    : units === null ? "Enter a valid amount"
    : problem ?? (route.isError ? "No route for this amount" : loading ? "Finding the best route" : `Deposit from ${network}`);

  return <>
    <div className="rfq-amount">
      <label className={`rfq-amount__field${problem ? " is-error" : ""}`}>
        <input ref={input} id="funds-amount" inputMode="decimal" placeholder="0" autoComplete="off" aria-label={`Amount in ${token.symbol}`} value={amount}
          aria-invalid={!!problem || undefined} aria-describedby="funds-meta" disabled={busy}
          onChange={event => new RegExp(`^\\d*\\.?\\d{0,${token.decimals}}$`).test(event.target.value) && setAmount(event.target.value)} />
        <span className="rfq-amount__unit">{token.symbol}</span>
      </label>
      <div className="rfq-chips">
        {PRESET_PERCENTS.map(percent => <button key={percent} type="button" className="rfq-chip" disabled={!balance.data || busy}
          onClick={() => setAmount(tokenInput(percentOf(balance.data!, percent, token), token.decimals))}>{percent === 100 ? "Max" : `${percent}%`}</button>)}
      </div>
      <div id="funds-meta" className={`rfq-amount__meta${problem ? " is-error" : ""}`} aria-live="polite">
        <span>In your wallet on {network} {balance.data === undefined ? "—" : `${formatTokenAmount(balance.data, token.decimals, 6)} ${token.symbol}`}</span>
      </div>
    </div>
    {route.isError && units !== null && !over && <Banner tone="warning">{route.error instanceof Error ? route.error.message : "No route found"}. Try another amount or asset.</Banner>}
    {quote && <div className="route-summary" aria-live="polite">
      <Rows rows={[
        ["You receive", <><b>≈ {usdc(quote.toAmount)}</b> USDC</>],
        ["At least", usdc(quote.toAmountMin)],
        ["Rate", formatRate(quote, token.symbol)],
        ["Bridge and LI.FI fees", formatUsd(quote.feesUsd)],
        [`Network gas on ${network}`, formatUsd(quote.gasUsd)],
        ["Arrives", formatDuration(quote.durationSeconds)],
        ["Route", `${quote.tool} via LI.FI`],
      ]} />
    </div>}
    {quote && !problem && quote.loss !== null && quote.loss > WARN_ROUTE_LOSS && <Banner tone="warning">Fees and price impact take {(quote.loss * 100).toFixed(1)}% of this amount.</Banner>}
    <p className="footnote rfq-muted sheet-note">LI.FI swaps and bridges your {token.symbol} into USDC in your own Base wallet. You pay network gas on {network}. When it lands, you sign once to move it into your trading balance, and we pay that gas.</p>
    <button type="button" className="rfq-btn rfq-btn--lg rfq-btn--primary rfq-btn--block" disabled={!trader.address || !quote || !!problem || busy} onClick={submit}>
      {(busy || loading) && <span className="rfq-spinner" />}{label}
    </button>
  </>;
}

/** A share of the balance; Max on a native asset keeps a little back for the transfer's own gas. */
function percentOf(balance: bigint, percent: number, token: SourceToken) {
  const native = token.address === "0x0000000000000000000000000000000000000000";
  const spendable = native ? balance - balance / 50n : balance;
  return percent === 100 ? spendable : spendable * BigInt(percent) / 100n;
}
const tokenInput = (value: bigint, decimals: number) => formatTokenAmount(value, decimals, Math.min(decimals, 8)).replace(/,/g, "");
