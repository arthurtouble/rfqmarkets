import { useEffect, useState } from "react";
import { API, INDEXER, base, dollars } from "./config.js";
import type { AccountState, Market, Quote, Side, WalletProvider } from "./types.js";

const chains = { 1: "Ethereum", 42161: "Arbitrum", 10: "Optimism", 8453: "Base" } as const;
type QuickSession={account:string;privateKey:string;validUntil:number};

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
  const [showWithdraw, setShowWithdraw] = useState(false);
  const [withdrawAmount, setWithdrawAmount] = useState("100");
  const [withdrawStatus, setWithdrawStatus] = useState("Withdrawal gas is sponsored");
  const [paused, setPaused] = useState(false);
  const [quickSession,setQuickSession]=useState<QuickSession|null>(null);

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
    const protocolRequest=fetch(`${INDEXER}/v1/protocol`).then(response=>response.ok?response.json():null).catch(()=>null);
    let response = await fetch(`${INDEXER}/v1/account/${address}`);
    if (!response.ok) response = await fetch(`${API}/v1/account/${address}`);
    if (response.ok) setAccountState(await response.json());
    const protocol=await protocolRequest;if(protocol)setPaused(Boolean(protocol.paused));
  }
  const randomNonce=()=>BigInt(`0x${[...crypto.getRandomValues(new Uint8Array(32))].map(value => value.toString(16).padStart(2, "0")).join("")}`).toString();
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
    setAccount(accounts[0]);
    try{const stored=sessionStorage.getItem(`rfq-session:${accounts[0].toLowerCase()}`);const parsed=stored?JSON.parse(stored) as QuickSession:null;setQuickSession(parsed&&parsed.validUntil>Date.now()?parsed:null);}catch{setQuickSession(null);}
    void refreshAccount(accounts[0]);
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
      const nonce = randomNonce();
      const prepared = await post("/v1/prepare", { quoteId: current.quoteId, account: connected.account, nonce });
      let userSignature:string;
      if(quickSession&&quickSession.account.toLowerCase()===connected.account.toLowerCase()&&quickSession.validUntil>Date.now()&&Number(amount)<=2_500){setStatus("Signing with quick session…");const {SigningKey,TypedDataEncoder}=await import("ethers");const digest=TypedDataEncoder.hash(prepared.domain,prepared.types,prepared.intent);userSignature=new SigningKey(quickSession.privateKey).sign(digest).serialized;}
      else userSignature = await signTyped(connected, prepared, "TradeIntent");
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
  async function withdraw() {
    setWithdrawStatus("Waiting for wallet…");
    try {
      const connected=await wallet();
      const prepared=await post("/v1/withdraw/prepare",{account:connected.account,amount:withdrawAmount,nonce:randomNonce()});
      const userSignature=await signTyped(connected,prepared,"WithdrawalIntent");setWithdrawStatus("Submitting sponsored withdrawal…");
      const result=await post("/v1/withdraw/execute",{intent:prepared.intent,userSignature});
      setWithdrawStatus(`Withdrawn ${withdrawAmount} USDC · block ${result.transaction.blockNumber}`);await refreshAccount(connected.account);
    }catch(error){setWithdrawStatus(error instanceof Error?error.message:"Withdrawal unavailable");}
  }
  async function emergencyClose(closeMarket:Market){
    setStatus("Waiting for emergency close signature…");
    try{
      const connected=await wallet();const prepared=await post("/v1/close/prepare",{account:connected.account,market:closeMarket,nonce:randomNonce()});
      const userSignature=await signTyped(connected,prepared,"CloseIntent");setStatus("Submitting conservative close…");
      const result=await post("/v1/close/execute",{intent:prepared.intent,userSignature});setStatus(`Closed ${closeMarket} in block ${result.transaction.blockNumber}`);await refreshAccount(connected.account);
    }catch(error){setStatus(error instanceof Error?error.message:"Close unavailable");}
  }
  async function enableQuickTrading(){
    setStatus("Waiting for session approval…");
    try{
      const connected=await wallet();const {computeAddress}=await import("ethers");const privateKey=`0x${[...crypto.getRandomValues(new Uint8Array(32))].map(value=>value.toString(16).padStart(2,"0")).join("")}`,sessionAddress=computeAddress(privateKey);const prepared=await post("/v1/session/prepare",{account:connected.account,session:sessionAddress,marketMask:3,maxTradeAmount:"2500",maxCumulativeAmount:"10000",maxFee:"5",durationSeconds:28_800,nonce:randomNonce()});
      const userSignature=await signTyped(connected,{...prepared,intent:prepared.grant},"SessionGrant");setStatus("Activating sponsored session…");
      const result=await post("/v1/session/execute",{grant:prepared.grant,userSignature});const session={account:connected.account,privateKey,validUntil:Number(result.validUntil)*1_000};sessionStorage.setItem(`rfq-session:${connected.account.toLowerCase()}`,JSON.stringify(session));setQuickSession(session);setStatus("Quick trading active for 8 hours");
    }catch(error){setStatus(error instanceof Error?error.message:"Session unavailable");}
  }
  async function disableQuickTrading(){
    if(!quickSession)return;
    setStatus("Waiting for session revocation…");
    try{
      const connected=await wallet();
      const {computeAddress}=await import("ethers");const config=await fetch(`${API}/v1/config`).then(response=>response.json());
      const sessionAddress=computeAddress(quickSession.privateKey),data=`0x1fa5d6a4${sessionAddress.slice(2).padStart(64,"0")}`;
      const hash=await connected.provider.request({method:"eth_sendTransaction",params:[{from:connected.account,to:config.clearingAddress,data}]}) as string;
      setStatus(`Revocation submitted · ${hash.slice(0,10)}…`);
      for(let attempt=0;attempt<40;attempt++){
        const receipt=await connected.provider.request({method:"eth_getTransactionReceipt",params:[hash]}) as {status?:string}|null;
        if(receipt?.status==="0x0")throw new Error("Session revocation reverted");
        if(receipt?.status==="0x1"){
          sessionStorage.removeItem(`rfq-session:${connected.account.toLowerCase()}`);setQuickSession(null);setStatus("Quick trading revoked on-chain");return;
        }
        await new Promise(resolve=>setTimeout(resolve,250));
      }
      setStatus(`Revocation pending · ${hash.slice(0,10)}…`);
    }catch(error){setStatus(error instanceof Error?error.message:"Session revocation unavailable");}
  }

  return <section className="trade-card">
    {accountState && <><div className="balance"><span>Collateral</span><strong>{dollars(accountState.collateral)}</strong><small>BTC {base(accountState.positions.BTC.size)} · ETH {base(accountState.positions.ETH.size)}</small><button className="balance-action" onClick={()=>setShowWithdraw(value=>!value)}>{showWithdraw?"Close":"Withdraw"}</button></div>{showWithdraw&&<section className="depositPanel accountPanel"><label>Withdraw to connected wallet</label><div className="amount compact"><input aria-label="Withdrawal amount" inputMode="decimal" value={withdrawAmount} onChange={event=>setWithdrawAmount(event.target.value)}/><b>USDC</b></div><button className="route" onClick={withdraw}>Sign & withdraw</button><p className="status">{withdrawStatus}</p></section>}{paused&&(BigInt(accountState.positions.BTC.size)!==0n||BigInt(accountState.positions.ETH.size)!==0n)&&<section className="emergencyPanel"><strong>Trading paused</strong><span>Close at the verified directional oracle price.</span><div>{BigInt(accountState.positions.BTC.size)!==0n&&<button onClick={()=>emergencyClose("BTC")}>Close BTC</button>}{BigInt(accountState.positions.ETH.size)!==0n&&<button onClick={()=>emergencyClose("ETH")}>Close ETH</button>}</div></section>}</>}
    <div className="markets">{(["BTC", "ETH"] as Market[]).map(value => <button key={value} className={market === value ? "active" : ""} onClick={() => setMarket(value)}>{value}-PERP</button>)}</div>
    <label>Amount <span>USDC</span></label><div className="amount"><input aria-label="Trade amount" inputMode="decimal" value={amount} onChange={event => setAmount(event.target.value)} /><b>USDC</b></div>
    <div className="sides"><button className={side === "buy" ? "buy active" : "buy"} onClick={() => setSide("buy")}>Buy</button><button className={side === "sell" ? "sell active" : "sell"} onClick={() => setSide("sell")}>Sell</button></div>
    <dl><div><dt>Estimated price</dt><dd>{dollars(quote?.expectedPrice)}</dd></div><div><dt>Maximum fee</dt><dd>{dollars(quote?.fee)}</dd></div><div><dt>Price protection</dt><dd>{dollars(quote?.worstPrice)}</dd></div></dl>
    <button className={`submit ${side}`} disabled={!quote} onClick={approve}>{side === "buy" ? "Buy" : "Sell"} {market}</button><p className="status"><i />{status}</p>
    <button className="depositToggle" onClick={() => setShowDeposit(value => !value)}>{showDeposit ? "Hide deposit" : "Deposit from any chain"}</button>
    {showDeposit && <section className="depositPanel"><div className="depositGrid"><label>From<select value={sourceChain} onChange={event => setSourceChain(Number(event.target.value) as keyof typeof chains)}>{Object.entries(chains).map(([id, name]) => <option value={id} key={id}>{name}</option>)}</select></label><label>Asset<select value={sourceToken} onChange={event => setSourceToken(event.target.value as "ETH" | "USDC" | "USDT")}><option>ETH</option><option>USDC</option><option>USDT</option></select></label></div><label>Deposit amount</label><div className="amount compact"><input aria-label="Deposit amount" inputMode="decimal" value={depositAmount} onChange={event => setDepositAmount(event.target.value)} /><b>{sourceToken}</b></div><button className="route" onClick={deposit}>Route & deposit</button><p className="status">{depositStatus}</p></section>}
    <button className="wallet trade-wallet" onClick={() => wallet().catch(error => setStatus(error instanceof Error ? error.message : "Wallet unavailable"))}>{account ? `${account.slice(0, 6)}…${account.slice(-4)}` : "Connect wallet"}</button>
    {account&&<button className={`depositToggle quickToggle ${quickSession?"active":""}`} onClick={quickSession?disableQuickTrading:enableQuickTrading}>{quickSession?"Revoke quick trading":"Enable quick trading"}</button>}
  </section>;
}
