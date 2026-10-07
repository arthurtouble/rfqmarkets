// The emergency exit page: connect a wallet, see the account, and leave without the RFQ Markets app.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getAddress, isAddress, isHexString, type Contract, type ContractTransactionResponse } from "ethers";
import { ExitChain, RESOLUTION_BATCH, type Session } from "./chain.js";
import { explorerAddress, explorerTx, type ExitConfig } from "./config.js";
import { explain, type ExitAction } from "./errors.js";
import {
  abs, claimable, closePnl, exitPrice, formatEth, formatSignedUsd, formatSize, formatUsd, parseNonce, parseUsdc, resolutionPhase,
  shortAddress, side, staleMarkets, usdcInput, withdrawMax, withdrawable, type AccountState, type Position,
} from "./model.js";
import { ActionButton, Banner, Card, ExternalIcon, Toast, WalletIcon, type ToastState } from "./ui.js";
import { discoverWallets, requestAccount, switchChain, walletAppLinks, walletChainId, type Eip1193, type WalletOption } from "./wallet.js";

const LAST_WALLET = "rfq.exit.wallet";
const remember = (id: string) => { try { localStorage.setItem(LAST_WALLET, id); } catch { /* private mode */ } };
const remembered = () => { try { return localStorage.getItem(LAST_WALLET); } catch { return null; } };

interface Connection {
  wallet: WalletOption;
  account: string;
  chainId: bigint;
}

type Report = { report: string; validUntil?: number };

export function App({ config }: { config: ExitConfig }) {
  const [wallets, setWallets] = useState<WalletOption[] | null>(null);
  const [connection, setConnection] = useState<Connection | null>(null);
  const [state, setState] = useState<AccountState | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [toast, setToast] = useState<ToastState | null>(null);
  const [sessions, setSessions] = useState<Session[] | null | "loading">(null);
  const [manualReport, setManualReport] = useState("");

  const onChain = connection?.chainId === config.chainId;
  const chain = useMemo(() => (connection && onChain ? new ExitChain(config, connection.wallet.provider) : null), [config, connection, onChain]);

  useEffect(() => { void discoverWallets().then(setWallets); }, []);

  const connect = useCallback(async (wallet: WalletOption) => {
    setBusy(`connect:${wallet.id}`);
    try {
      const account = await requestAccount(wallet.provider);
      setConnection({ wallet, account: getAddress(account), chainId: await walletChainId(wallet.provider) });
      remember(wallet.id);
      setToast(null);
    } catch (error) {
      setToast({ kind: "error", title: "Not connected", body: explain(error, "connect") });
    } finally {
      setBusy(null);
    }
  }, []);

  // Reconnect silently to the wallet used last time if it already trusts this page.
  useEffect(() => {
    if (!wallets || connection) return;
    const last = wallets.find(wallet => wallet.id === remembered());
    if (!last) return;
    void (last.provider.request({ method: "eth_accounts" }) as Promise<string[]>).then(async accounts => {
      if (accounts?.length) setConnection({ wallet: last, account: getAddress(accounts[0]), chainId: await walletChainId(last.provider) });
    }).catch(() => undefined);
  }, [wallets, connection]);

  // Follow account and network changes made in the wallet.
  useEffect(() => {
    const provider = connection?.wallet.provider;
    if (!provider?.on) return;
    const onAccounts = (...args: unknown[]) => {
      const accounts = args[0] as string[];
      setState(null); setSessions(null);
      setConnection(current => current && (accounts?.length ? { ...current, account: getAddress(accounts[0]) } : null));
    };
    const onChainChanged = (...args: unknown[]) => {
      setState(null); setSessions(null);
      setConnection(current => current && { ...current, chainId: BigInt(args[0] as string) });
    };
    provider.on("accountsChanged", onAccounts);
    provider.on("chainChanged", onChainChanged);
    return () => { provider.removeListener?.("accountsChanged", onAccounts); provider.removeListener?.("chainChanged", onChainChanged); };
  }, [connection?.wallet]);

  const account = connection?.account;
  const reload = useCallback(async () => {
    if (!chain || !account) return;
    try {
      await chain.checkDeployment();
      setState(await chain.read(account));
      setLoadError(null);
    } catch (error) {
      setLoadError(explain(error, "connect"));
    }
  }, [chain, account]);

  useEffect(() => {
    if (!chain || !account) return;
    void reload();
    const timer = setInterval(() => { if (document.visibilityState === "visible") void reload(); }, 12_000);
    return () => clearInterval(timer);
  }, [chain, account, reload]);

  const findSessions = useCallback(async () => {
    if (!chain || !account) return;
    setSessions("loading");
    setSessions(await chain.sessions(account).catch(() => null));
  }, [chain, account]);
  useEffect(() => { if (state && sessions === null) void findSessions(); }, [state, sessions, findSessions]);

  /** A report for `markets`: the one pasted under Advanced, or a fresh one from the oracle nodes. */
  const report = useCallback(async (markets: number[]): Promise<Report> => {
    const pasted = manualReport.trim();
    if (pasted) {
      if (!isHexString(pasted) || pasted.length < 4 || pasted.length % 2) throw new Error("The pasted report is not valid hex. Clear it to use the oracle nodes.");
      return { report: pasted };
    }
    return chain!.fetchReport(markets);
  }, [chain, manualReport]);

  /** Sends one transaction and reports it in the toast. Returns true once it is confirmed. */
  const send = useCallback(async (title: string, action: ExitAction, transaction: (clearing: Contract) => Promise<ContractTransactionResponse>, options: { step?: string; expiresAt?: number } = {}) => {
    const prefix = options.step ? `${options.step}: ` : "";
    setToast({ kind: "pending", title: `${prefix}${title}`, body: "Confirm in your wallet.", expiresAt: options.expiresAt });
    try {
      const tx = await chain!.send(transaction);
      const href = explorerTx(config, tx.hash);
      setToast({ kind: "pending", title: `${prefix}${title}`, body: "Waiting for the network to confirm.", link: href ? { href, label: "View transaction" } : undefined });
      const receipt = await tx.wait();
      if (receipt?.status !== 1) throw new Error("The transaction failed on chain.");
      return { ok: true as const, href };
    } catch (error) {
      setToast({ kind: "error", title: `${title} failed`, body: explain(error, action) });
      return { ok: false as const };
    }
  }, [chain, config]);

  const run = useCallback(async (key: string, work: () => Promise<void>) => {
    setBusy(key);
    try {
      await work();
    } catch (error) {
      setToast({ kind: "error", title: "Could not continue", body: explain(error, "connect") });
    } finally {
      setBusy(null);
      void reload();
    }
  }, [reload]);

  const succeed = (title: string, body?: string, href?: string) => setToast({ kind: "success", title, body, link: href ? { href, label: "View transaction" } : undefined });

  // ---- Actions ----

  const withdraw = (amount: bigint) => run("withdraw", async () => {
    const latest = await chain!.read(account!);
    const stale = staleMarkets(latest);
    let step: string | undefined;
    if (stale.length) {
      // The contract needs a current price for every open position before it lets money out.
      setToast({ kind: "pending", title: "Getting the current price", body: "Asking the oracle nodes." });
      const fresh = await report(latest.positions.map(position => position.market));
      const refreshed = await send("Update the price on chain", "refresh", clearing => clearing.refreshOracle(fresh.report), { step: "Step 1 of 2", expiresAt: fresh.validUntil });
      if (!refreshed.ok) return;
      step = "Step 2 of 2";
    }
    const result = await send(`Withdraw ${formatUsd(amount)}`, "withdraw", clearing => clearing.withdraw(amount), { step });
    if (result.ok) succeed(`Withdrew ${formatUsd(amount)}`, "The USDC is in your wallet.", result.href);
  });

  const close = (position: Position) => run(`close:${position.market}`, async () => {
    setToast({ kind: "pending", title: "Getting the current price", body: "Asking the oracle nodes." });
    const fresh = await report([position.market]);
    const label = `${side(position)} ${position.symbol}`;
    const result = await send(`Close ${label}`, "close", clearing => clearing.closePosition(position.market, fresh.report), { expiresAt: fresh.validUntil });
    if (result.ok) succeed(`Closed ${label}`, "The result is in your balance. Withdraw it below.", result.href);
  });

  const claim = () => run("claim", async () => {
    const result = await send("Claim your payout", "claim", clearing => clearing.claimResolution());
    if (result.ok) succeed("Payout claimed", "The USDC is in your wallet.", result.href);
  });

  const sample = () => run("sample", async () => {
    setToast({ kind: "pending", title: "Getting the current price", body: "Asking the oracle nodes." });
    const fresh = await report([]);
    const result = await send("Record a price sample", "sample", clearing => clearing.submitResolutionObservation(fresh.report), { expiresAt: fresh.validUntil });
    if (result.ok) succeed("Price sample recorded", "Resolution needs samples at least 30 seconds apart.", result.href);
  });

  const processAccounts = () => run("process", async () => {
    const result = await send("Process accounts", "process", clearing => clearing.processResolution(RESOLUTION_BATCH));
    if (result.ok) succeed("Accounts processed", undefined, result.href);
  });

  const revoke = (session: string) => run(`revoke:${session}`, async () => {
    const result = await send("Turn off one-click trading", "revoke", clearing => clearing.revokeSession(session));
    if (result.ok) {
      succeed("One-click trading key revoked", "It can no longer sign trades for you.", result.href);
      setSessions(current => Array.isArray(current) ? current.filter(item => item.address !== session) : current);
    }
  });

  const cancelNonce = (nonce: bigint) => run("cancel", async () => {
    if (await chain!.nonceUsed(account!, nonce)) {
      setToast({ kind: "success", title: "Already unusable", body: "That number is already used or cancelled, so no order can use it." });
      return;
    }
    const result = await send("Cancel signed order", "cancel", clearing => clearing.cancelNonce(nonce));
    if (result.ok) succeed("Signed order cancelled", "Nothing signed with that number can execute now.", result.href);
  });

  const switchNetwork = () => run("switch", async () => {
    try {
      await switchChain(connection!.wallet.provider, config.chainId, config.chain);
      const chainId = await walletChainId(connection!.wallet.provider);
      setConnection(current => current && { ...current, chainId });
    } catch (error) {
      setToast({ kind: "error", title: "Network not switched", body: explain(error, "switch") });
    }
  });

  const disconnect = () => { setConnection(null); setState(null); setSessions(null); try { localStorage.removeItem(LAST_WALLET); } catch { /* private mode */ } };

  return <div className="exit-app">
    <header className="rfq-topbar exit-topbar">
      <a className="rfq-logo" href={config.appUrl}>RFQ Markets</a>
      <span className="rfq-badge rfq-badge--warning exit-tag">Emergency exit</span>
      <div className="rfq-topbar__end">
        {connection ? <button type="button" className="rfq-account-btn" onClick={disconnect} title="Disconnect">
          <span className="rfq-avatar" aria-hidden="true" /><span className="mono">{shortAddress(connection.account)}</span><span className="visually-hidden">Disconnect</span>
        </button> : null}
      </div>
    </header>

    <main className="exit-page">
      <div className="exit-hero">
        <h1>Emergency exit</h1>
        <p className="rfq-muted">Withdraw your money and close your positions directly on the contract, without the RFQ Markets app or its servers. Each action is a transaction from your own wallet, so you pay a small network fee in ETH.</p>
      </div>

      <VenueStatus config={config} state={state} />

      {!connection ? <ConnectCard wallets={wallets} busy={busy} onConnect={connect} /> : null}

      {connection && !onChain ? <Banner tone="warning" action={<ActionButton block={false} busy={busy === "switch"} onClick={switchNetwork}>Switch to {config.chain.name}</ActionButton>}>
        <b>Wrong network.</b> Your wallet is on another network. Switch it to {config.chain.name} to see your account.
      </Banner> : null}

      {connection && onChain && loadError ? <Banner tone="danger" action={<button type="button" className="rfq-btn rfq-btn--secondary rfq-btn--sm" onClick={() => void reload()}>Retry</button>}>{loadError}</Banner> : null}

      {connection && onChain && !state && !loadError ? <section className="rfq-card rfq-card--pad exit-card" aria-busy="true" aria-label="Loading your account">
        <div className="rfq-skel" style={{ height: 22, width: "40%" }} />
        <div className="rfq-skel" style={{ height: 44, width: "60%" }} />
        <div className="rfq-skel" style={{ height: 18, width: "80%" }} />
      </section> : null}

      {state ? <>
        <BalanceCard state={state} />
        <ResolutionCard state={state} busy={busy} onSample={sample} onProcess={processAccounts} onClaim={claim} />
        {resolutionPhase(state.resolution) === "none" ? <>
          <PositionsCard state={state} busy={busy} appUrl={config.appUrl} onClose={close} />
          <WithdrawCard state={state} busy={busy} onWithdraw={withdraw} />
        </> : null}
        <SessionsCard sessions={sessions} busy={busy} onRevoke={revoke} onRescan={findSessions} />
        <AdvancedCard busy={busy} manualReport={manualReport} onManualReport={setManualReport} onCancel={cancelNonce} config={config} />
      </> : null}

      <footer className="exit-footer rfq-faint">
        <p>This page talks only to your wallet, the contract{config.oracleNodes.length ? " and the three public oracle nodes for prices" : ""}. It works when the app and its servers are down. <a href={config.docsUrl} target="_blank" rel="noreferrer">How exits work <ExternalIcon /></a></p>
      </footer>
    </main>
    <Toast toast={toast} onClose={() => setToast(null)} />
  </div>;
}

// ---- Sections ----

function VenueStatus({ config, state }: { config: ExitConfig; state: AccountState | null }) {
  const phase = state ? resolutionPhase(state.resolution) : null;
  const status = !state ? null
    : phase !== "none" ? <span className="rfq-badge rfq-badge--short"><span className="rfq-dot" />In resolution</span>
    : state.paused ? <span className="rfq-badge rfq-badge--warning"><span className="rfq-dot" />Trading paused</span>
    : <span className="rfq-badge rfq-badge--long"><span className="rfq-dot" />Trading open</span>;
  const contractLink = explorerAddress(config, config.clearing);
  return <dl className="rfq-dl exit-venue">
    <div><dt>Network</dt><dd>{config.chain.name}</dd></div>
    <div><dt>Contract</dt><dd>{contractLink ? <a className="mono" href={contractLink} target="_blank" rel="noreferrer">{shortAddress(config.clearing)} <ExternalIcon /></a> : <span className="mono">{shortAddress(config.clearing)}</span>}</dd></div>
    {status ? <div><dt>Venue</dt><dd>{status}</dd></div> : null}
  </dl>;
}

function ConnectCard({ wallets, busy, onConnect }: { wallets: WalletOption[] | null; busy: string | null; onConnect: (wallet: WalletOption) => void }) {
  const links = useMemo(() => walletAppLinks(window.location.href), []);
  return <Card id="connect" title="Connect your wallet" intro="Use the wallet you trade with. Nothing is sent until you approve it in your wallet.">
    {wallets === null ? <div className="rfq-skel" style={{ height: 64 }} /> : wallets.length ? <div className="rfq-list wallet-list">
      {wallets.map(wallet => <button key={wallet.id} type="button" className="rfq-row wallet-row" disabled={busy !== null} onClick={() => onConnect(wallet)}>
        {wallet.icon ? <img src={wallet.icon} alt="" width={36} height={36} /> : <span className="wallet-fallback"><WalletIcon /></span>}
        <span className="rfq-row__title">{wallet.name}</span>
        <span className="rfq-row__sub">{busy === `connect:${wallet.id}` ? "Check your wallet" : "Connect"}</span>
      </button>)}
    </div> : <div className="stack-sm">
      <Banner>No browser wallet found. On a phone, open this page inside your wallet app's browser. On a computer, install or unlock your wallet extension and reload.</Banner>
      <div className="link-buttons">{links.map(link => <a key={link.name} className="rfq-btn rfq-btn--secondary" href={link.href}>Open in {link.name}</a>)}</div>
    </div>}
  </Card>;
}

function BalanceCard({ state }: { state: AccountState }) {
  const available = withdrawable(state);
  const negative = state.collateral < 0n;
  return <section className="rfq-card rfq-card--pad exit-card" aria-label="Your account">
    <div className="exit-balance">
      <span className="rfq-muted">Balance in the contract</span>
      <span className="exit-balance__value tnum">{formatUsd(state.collateral)}</span>
    </div>
    <dl className="rfq-dl">
      {state.resolution.required ? null : <div><dt>Available to withdraw{state.positions.length ? " (estimate)" : ""}</dt><dd>{formatUsd(available)}</dd></div>}
      <div><dt>Open positions</dt><dd>{state.positions.length}</dd></div>
      <div><dt>In your wallet</dt><dd>{formatUsd(state.walletUsdc)} · {formatEth(state.walletEth)}</dd></div>
    </dl>
    {negative ? <Banner tone="danger">Your balance is below zero after losses. Closing your positions settles it.</Banner> : null}
    {state.walletEth === 0n ? <Banner tone="warning"><b>No ETH for fees.</b> Every action here is a transaction you pay for. Add a little ETH on this network to your wallet first.</Banner> : null}
  </section>;
}

function PositionsCard({ state, busy, appUrl, onClose }: { state: AccountState; busy: string | null; appUrl: string; onClose: (position: Position) => void }) {
  if (!state.positions.length) return null;
  return <Card id="positions" title="Close a position" intro={state.paused
    ? "Trading is paused, so you can close here at the oracle price with no fee. Longs close at the bid and shorts at the ask."
    : <>Trading is open. Close positions in the <a href={appUrl}>app</a>; closing here unlocks only while trading is paused.</>}>
    <div className="positions">
      {state.positions.map(position => {
        const price = state.prices.get(position.market);
        const at = price ? exitPrice(position, price) : 0n;
        const pnl = price ? closePnl(position, at) : 0n;
        return <article key={position.market} className="rfq-pos" aria-label={`${side(position)} ${position.symbol}`}>
          <div className="rfq-pos__head">
            <span className={`rfq-badge ${position.size > 0n ? "rfq-badge--long" : "rfq-badge--short"}`}>{side(position)}</span>
            <b>{formatSize(position.size, position.symbol)}</b>
            <span className={`rfq-pos__pnl tnum ${pnl > 0n ? "rfq-up" : pnl < 0n ? "rfq-down" : ""}`}>{formatSignedUsd(pnl)}</span>
          </div>
          <div className="rfq-pos__grid">
            <div><span>Entry</span><b>{formatUsd(position.entryPrice)}</b></div>
            <div><span>Last price</span><b>{price ? formatUsd(at) : "—"}</b></div>
            <div><span>Value</span><b>{formatUsd(abs(position.size) * position.entryPrice / 10n ** 18n)}</b></div>
          </div>
          <ActionButton tone="secondary" busy={busy === `close:${position.market}`} disabled={!state.paused || busy !== null} onClick={() => onClose(position)}>
            {state.paused ? `Close ${side(position).toLowerCase()} at oracle price` : "Available while trading is paused"}
          </ActionButton>
        </article>;
      })}
    </div>
    <p className="footnote rfq-faint">PnL uses the last price on chain, before funding. The close uses a fresh price from the oracle nodes.</p>
  </Card>;
}

function WithdrawCard({ state, busy, onWithdraw }: { state: AccountState; busy: string | null; onWithdraw: (amount: bigint) => void }) {
  const [text, setText] = useState("");
  const amount = parseUsdc(text);
  const max = withdrawMax(state);
  const tooMuch = amount !== null && amount > (state.positions.length ? withdrawable(state) : state.collateral);
  const invalid = text.trim() !== "" && amount === null;
  const needsRefresh = state.positions.length > 0 && staleMarkets(state).length > 0;
  const previousCollateral = useRef(state.collateral);
  useEffect(() => { if (state.collateral < previousCollateral.current) setText(""); previousCollateral.current = state.collateral; }, [state.collateral]);
  const presets = [25n, 50n, 100n];
  return <Card id="withdraw" title="Withdraw" intro={state.positions.length
    ? "With positions open, you can withdraw what is not needed as margin. Close positions first to withdraw everything."
    : "Send your balance from the contract to your wallet."}>
    <div className="rfq-amount">
      <label className={`rfq-amount__field${invalid || tooMuch ? " is-error" : ""}${text.length > 7 ? " is-long" : ""}`}>
        <span className="rfq-amount__prefix" aria-hidden="true">$</span>
        <input inputMode="decimal" placeholder="0" value={text} aria-label="Amount in USDC" aria-invalid={invalid || tooMuch || undefined} onChange={event => setText(event.target.value)} />
        <span className="rfq-amount__unit">USDC</span>
      </label>
      <div className={`rfq-amount__meta${invalid || tooMuch ? " is-error" : ""}`}>
        <span>{invalid ? "Enter an amount like 25 or 25.50." : tooMuch ? "More than you can withdraw now." : `Up to ${formatUsd(max)}`}</span>
      </div>
      <div className="rfq-chips" role="group" aria-label="Amount presets">
        {presets.map(percent => <button key={percent.toString()} type="button" className="rfq-chip" disabled={max === 0n} onClick={() => setText(usdcInput(percent === 100n ? max : max * percent / 100n / 10_000n * 10_000n))}>{percent === 100n ? "Max" : `${percent}%`}</button>)}
      </div>
    </div>
    {needsRefresh ? <p className="footnote rfq-muted">The price on chain is out of date, so your wallet will ask twice: once to update the price, then for the withdrawal.</p> : null}
    <ActionButton busy={busy === "withdraw"} disabled={busy !== null || amount === null || tooMuch} onClick={() => amount && onWithdraw(amount)}>
      {amount ? `Withdraw ${formatUsd(amount)}` : "Withdraw"}
    </ActionButton>
  </Card>;
}

function ResolutionCard({ state, busy, onSample, onProcess, onClaim }: { state: AccountState; busy: string | null; onSample: () => void; onProcess: () => void; onClaim: () => void }) {
  const phase = resolutionPhase(state.resolution);
  if (phase === "none") return null;
  const r = state.resolution;
  const owed = claimable(r);
  const steps = [
    { done: phase !== "pricing", label: "Fix the resolution prices", detail: phase === "pricing" ? `${r.samples} of 3 price samples recorded. Samples must be at least 30 seconds apart.` : "Done." },
    { done: phase === "claimable", label: "Work out every account's claim", detail: phase === "claimable" ? "Done." : phase === "processing" ? `${r.cursor.toString()} of ${r.accounts.toString()} accounts processed.` : "After the prices are fixed." },
    { done: phase === "claimable" && owed === 0n && r.paid > 0n, label: "Claim your payout", detail: phase === "claimable" ? (r.claim === 0n ? "This wallet has no claim." : `Your claim is ${formatUsd(r.claim)}${r.assets < r.totalClaims ? `, paid at ${(Number(r.assets * 10_000n / r.totalClaims) / 100).toFixed(2)}% because the venue is short` : ""}.`) : "After every account is processed." },
  ];
  return <Card id="resolution" title="The venue is winding down" badge={<span className="rfq-badge rfq-badge--short">Resolution</span>}
    intro="Trading, withdrawals and closes have stopped. Every account is settled at fixed prices and paid from what the contract holds, in the same proportion. Anyone can push the steps along, so you do not have to wait for the operator.">
    <ol className="steps">
      {steps.map((step, index) => <li key={step.label} className={step.done ? "is-done" : ""}>
        <span className="steps__num" aria-hidden="true">{index + 1}</span>
        <div><b>{step.label}</b><span className="rfq-muted">{step.detail}</span></div>
      </li>)}
    </ol>
    {phase === "pricing" ? <ActionButton busy={busy === "sample"} disabled={busy !== null} onClick={onSample}>Record a price sample</ActionButton> : null}
    {phase === "processing" ? <ActionButton busy={busy === "process"} disabled={busy !== null} onClick={onProcess}>Process the next {RESOLUTION_BATCH.toString()} accounts</ActionButton> : null}
    {phase === "claimable" && owed > 0n ? <ActionButton busy={busy === "claim"} disabled={busy !== null} onClick={onClaim}>Claim {formatUsd(owed)}</ActionButton> : null}
    {phase === "claimable" && owed === 0n && r.paid > 0n ? <Banner>You have claimed {formatUsd(r.paid)}. If the venue recovers more money later, come back to claim the rest.</Banner> : null}
  </Card>;
}

function SessionsCard({ sessions, busy, onRevoke, onRescan }: { sessions: Session[] | null | "loading"; busy: string | null; onRevoke: (session: string) => void; onRescan: () => void }) {
  const [typed, setTyped] = useState("");
  const valid = isAddress(typed.trim());
  return <Card id="sessions" title="Turn off one-click trading" intro="One-click trading uses a key the app holds for you. Revoke it to make sure nothing can trade for you.">
    {sessions === "loading" ? <p className="rfq-muted footnote">Looking for your keys…</p>
      : sessions === null ? <p className="rfq-muted footnote">Your wallet's network connection could not search for your keys. Paste a key's address below, or <button type="button" className="link-button" onClick={onRescan}>try again</button>.</p>
      : sessions.length === 0 ? <p className="rfq-muted footnote">No active one-click trading keys found.</p>
      : <ul className="session-list">{sessions.map(session => <li key={session.address}>
        <div><span className="mono">{shortAddress(session.address)}</span><span className="rfq-faint footnote">Valid until {new Date(session.validUntil * 1000).toLocaleString()}</span></div>
        <ActionButton block={false} tone="danger" busy={busy === `revoke:${session.address}`} disabled={busy !== null} onClick={() => onRevoke(session.address)}>Revoke</ActionButton>
      </li>)}</ul>}
    <details className="exit-details">
      <summary>Revoke a key by its address</summary>
      <div className="inline-form">
        <div className="rfq-field">
          <label htmlFor="session-address">Key address</label>
          <div className="rfq-field__box"><input id="session-address" className="mono" placeholder="0x…" spellCheck={false} autoComplete="off" value={typed} onChange={event => setTyped(event.target.value)} /></div>
        </div>
        <ActionButton block={false} tone="secondary" busy={busy === `revoke:${valid ? getAddress(typed.trim()) : ""}`} disabled={!valid || busy !== null} onClick={() => onRevoke(getAddress(typed.trim()))}>Revoke</ActionButton>
      </div>
    </details>
  </Card>;
}

function AdvancedCard({ busy, manualReport, onManualReport, onCancel, config }: { busy: string | null; manualReport: string; onManualReport: (text: string) => void; onCancel: (nonce: bigint) => void; config: ExitConfig }) {
  const [nonceText, setNonceText] = useState("");
  const nonce = parseNonce(nonceText);
  return <details className="rfq-card rfq-card--pad exit-card exit-advanced">
    <summary><h2>Advanced</h2></summary>
    <div className="stack">
      <div className="stack-sm">
        <h3>Cancel a signed order</h3>
        <p className="rfq-muted footnote">Every order you sign carries a number (its nonce). Cancelling the number means that order can never execute, even if someone still holds the signature.</p>
        <div className="inline-form">
          <div className="rfq-field">
            <label htmlFor="nonce">Order nonce</label>
            <div className="rfq-field__box"><input id="nonce" inputMode="numeric" placeholder="The number shown with the order" value={nonceText} onChange={event => setNonceText(event.target.value)} /></div>
          </div>
          <ActionButton block={false} tone="secondary" busy={busy === "cancel"} disabled={nonce === null || busy !== null} onClick={() => nonce !== null && onCancel(nonce)}>Cancel order</ActionButton>
        </div>
      </div>
      <div className="stack-sm">
        <h3>Use your own oracle report</h3>
        <p className="rfq-muted footnote">Closes and price updates fetch a signed price from the oracle nodes{config.oracleNodes.length ? ` (${config.oracleNodes.map(node => new URL(node).host).join(", ")})` : ""}. If they are unreachable, paste a report you assembled yourself; it is used instead until you clear it. It is valid for 15 seconds after it was signed.</p>
        <div className="rfq-field">
          <label htmlFor="report">Report (hex)</label>
          <textarea id="report" className="mono report-input" spellCheck={false} placeholder="0x…" value={manualReport} onChange={event => onManualReport(event.target.value)} />
        </div>
      </div>
    </div>
  </details>;
}
