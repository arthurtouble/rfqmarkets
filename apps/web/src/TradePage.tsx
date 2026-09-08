import { useEffect, useState } from "react";
import { API, INDEXER, dollars } from "./config.js";
import type { AccountState, Market, Quote, Side, WalletProvider } from "./types.js";

const chains = { 1: "Ethereum", 42161: "Arbitrum", 10: "Optimism", 8453: "Base" } as const;

export function TradePage() {
  const [market, setMarket] = useState<Market>("BTC");
  const [side, setSide] = useState<Side>("buy");
  const [amount, setAmount] = useState("1000");
  const [quote, setQuote] = useState<Quote | null>(null);
  const [status, setStatus] = useState("Live estimate");
  const [account, setAccount] = useState<string | null>(null);
  const [accountState, setAccountState] = useState<AccountState | null>(null);
  const [showDeposit, setShowDeposit] = useState(false);
  const [sourceChain, setSourceChain] = useState<keyof typeof chains>(1);
  const [sourceToken, setSourceToken] = useState<"ETH" | "USDC" | "USDT">("ETH");
  const [depositAmount, setDepositAmount] = useState("1");
  const [depositStatus, setDepositStatus] = useState("Local route simulator");

  async function requestQuote(signal?: AbortSignal) {
    const response = await fetch(`${API}/v1/quote`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ market, side, amount }), signal });
    if (!response.ok) throw new Error((await response.json()).error);
    return response.json() as Promise<Quote>;
  }
  async function post(path: string, body: unknown) {
    const response = await fetch(`${API}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error ?? "Request failed");
    return result;
  }
  async function refreshAccount(address: string) {
    let response = await fetch(`${INDEXER}/v1/account/${address}`);
    if (!response.ok) response = await fetch(`${API}/v1/account/${address}`);
    if (response.ok) setAccountState(await response.json());
  }
  useEffect(() => {
    const controller = new AbortController();
    const refresh = async () => {
      try {
        setQuote(await requestQuote(controller.signal));
        setStatus(current => ["Waiting for wallet…", "Requesting two approvals…", "No browser wallet detected"].includes(current) || current.startsWith("Executed") ? current : "Live estimate");
      } catch (error) {
        if (!controller.signal.aborted) { setQuote(null); setStatus(error instanceof Error ? error.message : "Unavailable"); }
      }
    };
    const timer = setTimeout(refresh, 120); const interval = setInterval(refresh, 1_000);
    return () => { clearTimeout(timer); clearInterval(interval); controller.abort(); };
  }, [market, side, amount]);

  async function wallet(): Promise<{ provider: WalletProvider; account: string }> {
    const ethereum = (window as unknown as { ethereum?: WalletProvider }).ethereum;
    if (!ethereum) throw new Error("No browser wallet detected");
    const accounts = await ethereum.request({ method: "eth_requestAccounts" }) as string[];
    if (!accounts[0]) throw new Error("Wallet did not return an account");
    const config = await (await fetch(`${API}/v1/config`)).json();
    try { await ethereum.request({ method: "wallet_switchEthereumChain", params: [{ chainId: config.chainId }] }); }
    catch (error) {
      if ((error as { code?: number }).code !== 4902 || !config.rpcUrl) throw error;
      await ethereum.request({ method: "wallet_addEthereumChain", params: [{ chainId: config.chainId, chainName: config.chainName, rpcUrls: [config.rpcUrl], nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 } }] });
    }
    setAccount(accounts[0]); void refreshAccount(accounts[0]);
    return { provider: ethereum, account: accounts[0] };
  }
  async function signTyped(connected: { provider: WalletProvider; account: string }, prepared: { domain: Record<string, unknown>; types: Record<string, unknown>; intent: unknown }, primaryType: string) {
    const typedData = { domain: { ...prepared.domain, chainId: Number(prepared.domain.chainId) }, types: { EIP712Domain: [{ name: "name", type: "string" }, { name: "version", type: "string" }, { name: "chainId", type: "uint256" }, { name: "verifyingContract", type: "address" }], ...prepared.types }, primaryType, message: prepared.intent };
    return connected.provider.request({ method: "eth_signTypedData_v4", params: [connected.account, JSON.stringify(typedData)] }) as Promise<string>;
  }
  async function approve() {
    if (!quote) return;
    setStatus("Waiting for wallet…");
    try {
      const current = quote.expiresAtMs - Date.now() < 1_200 ? await requestQuote() : quote;
      if (current !== quote) setQuote(current);
      const connected = await wallet();
      const bytes = crypto.getRandomValues(new Uint8Array(32));
      const nonce = BigInt(`0x${[...bytes].map(value => value.toString(16).padStart(2, "0")).join("")}`).toString();
      const prepared = await post("/v1/prepare", { quoteId: current.quoteId, account: connected.account, nonce });
      const userSignature = await signTyped(connected, prepared, "TradeIntent");
      setStatus("Requesting two approvals…");
      const result = await post("/v1/approve", { quoteId: current.quoteId, account: connected.account, nonce, userSignature });
      setStatus(result.transaction ? `Executed in block ${result.transaction.blockNumber} · ${result.transaction.hash.slice(0, 10)}…` : "Approved by 2 of 3");
      await refreshAccount(connected.account);
    } catch (error) { setStatus(error instanceof Error ? error.message : "Unavailable"); }
  }
  async function deposit() {
    setDepositStatus("Waiting for wallet…");
    try {
      const connected = await wallet(); setDepositStatus("Finding a route…");
      const route = await post("/v1/deposit/quote", { account: connected.account, fromChainId: Number(sourceChain), fromToken: sourceToken, amount: depositAmount });
      setDepositStatus(`Approve deposit of about ${dollars(route.expectedUsdc)}`);
      const userSignature = await signTyped(connected, route, "DepositIntent"); setDepositStatus("Routing to Base USDC…");
      const result = await post("/v1/deposit/execute", { routeId: route.routeId, userSignature });
      setDepositStatus(`Deposited ${dollars(result.expectedUsdc)} · block ${result.transaction.blockNumber}`); await refreshAccount(connected.account);
    } catch (error) { setDepositStatus(error instanceof Error ? error.message : "Deposit unavailable"); }
  }

  return <section className="trade-card">
    {accountState && <div className="balance"><span>Collateral</span><strong>{dollars(accountState.collateral)}</strong><small>BTC {accountState.positions.BTC.size} · ETH {accountState.positions.ETH.size}</small></div>}
    <div className="markets">{(["BTC", "ETH"] as Market[]).map(value => <button key={value} className={market === value ? "active" : ""} onClick={() => setMarket(value)}>{value}-PERP</button>)}</div>
    <label>Amount <span>USDC</span></label><div className="amount"><input aria-label="Trade amount" inputMode="decimal" value={amount} onChange={event => setAmount(event.target.value)} /><b>USDC</b></div>
    <div className="sides"><button className={side === "buy" ? "buy active" : "buy"} onClick={() => setSide("buy")}>Buy</button><button className={side === "sell" ? "sell active" : "sell"} onClick={() => setSide("sell")}>Sell</button></div>
    <dl><div><dt>Estimated price</dt><dd>{dollars(quote?.expectedPrice)}</dd></div><div><dt>Maximum fee</dt><dd>{dollars(quote?.fee)}</dd></div><div><dt>Price protection</dt><dd>{dollars(quote?.worstPrice)}</dd></div></dl>
    <button className={`submit ${side}`} disabled={!quote} onClick={approve}>{side === "buy" ? "Buy" : "Sell"} {market}</button><p className="status"><i />{status}</p>
    <button className="depositToggle" onClick={() => setShowDeposit(value => !value)}>{showDeposit ? "Hide deposit" : "Deposit from any chain"}</button>
    {showDeposit && <section className="depositPanel"><div className="depositGrid"><label>From<select value={sourceChain} onChange={event => setSourceChain(Number(event.target.value) as keyof typeof chains)}>{Object.entries(chains).map(([id, name]) => <option value={id} key={id}>{name}</option>)}</select></label><label>Asset<select value={sourceToken} onChange={event => setSourceToken(event.target.value as "ETH" | "USDC" | "USDT")}><option>ETH</option><option>USDC</option><option>USDT</option></select></label></div><label>Deposit amount</label><div className="amount compact"><input aria-label="Deposit amount" inputMode="decimal" value={depositAmount} onChange={event => setDepositAmount(event.target.value)} /><b>{sourceToken}</b></div><button className="route" onClick={deposit}>Route & deposit</button><p className="status">{depositStatus}</p></section>}
    <button className="wallet trade-wallet" onClick={() => wallet().catch(error => setStatus(error instanceof Error ? error.message : "Wallet unavailable"))}>{account ? `${account.slice(0, 6)}…${account.slice(-4)}` : "Connect wallet"}</button>
  </section>;
}
