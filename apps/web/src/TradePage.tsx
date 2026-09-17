import { useEffect, useRef, useState } from "react";
import { API, INDEXER, MARKET_STREAM, base, dollars } from "./config.js";
import type { AccountState, Market, MarketSnapshot, Quote, RestingOrder, Side, TradeActivity, WalletProvider } from "./types.js";
import { constructQuote } from "../../../packages/shared/src/pricing.js";
import { quoteToWire } from "../../../packages/shared/src/wire.js";
import { markAccount } from "./account-view.js";
import { optionalJson, postJson } from "./http.js";
import { inputDollars, leverage, ratio, signedDollars } from "./presentation.js";
import { randomNonce, spreadFromWire } from "./trading-utils.js";

type QuickSession={account:string;sessionAddress:string;privateKey?:string;validUntil:number};
type ConnectedWallet={account:string;provider?:WalletProvider;privateKey?:string};
function PriceChart({values}:{values:number[]}){
  const width=800,height=230,pad=12,rawMin=Math.min(...values),rawMax=Math.max(...values),first=values[0]??0,last=values.at(-1)??0,minimumRange=Math.max(.01,Math.abs(last)*.0002),center=(rawMax+rawMin)/2,range=Math.max(rawMax-rawMin,minimumRange),min=center-range/2,max=center+range/2,moveBps=first?Math.abs(last/first-1)*10_000:0,trend=moveBps<.25?"flat":last>=first?"up":"down",color=trend==="flat"?"#7185ff":trend==="up"?"#00e6b8":"#ff3f69",points=values.map((value,index)=>`${pad+index*(width-pad*2)/Math.max(1,values.length-1)},${pad+(max-value)*(height-pad*2)/range}`).join(" ");
  return <div className="price-chart"><svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`Live price chart, ${trend}, ${Math.abs(last-first).toFixed(2)} dollars`} preserveAspectRatio="none"><defs><linearGradient id="chartFill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor={color} stopOpacity=".22"/><stop offset="1" stopColor={color} stopOpacity="0"/></linearGradient></defs><path d={`M ${points.replaceAll(" "," L ")} L ${width-pad},${height-pad} L ${pad},${height-pad} Z`} fill="url(#chartFill)"/><polyline points={points} fill="none" stroke={color} strokeWidth="2" vectorEffect="non-scaling-stroke"/></svg><span>Live session</span></div>;
}
function AssetIcon({market}:{market:Market}){return <span className={`asset-icon ${market.toLowerCase()}`} aria-hidden="true">{market==="BTC"?"₿":"◆"}</span>;}

export function TradePage({onWalletChange}:{onWalletChange?:(account:string|null)=>void}) {
  const [market, setMarket] = useState<Market>("BTC");
  const [side, setSide] = useState<Side>("buy");
  const [amount, setAmount] = useState("1000");
  const [quote, setQuote] = useState<Quote | null>(null);
  const [status, setStatus] = useState("Live estimate");
  const [account, setAccount] = useState<string | null>(null);
  const [accountState, setAccountState] = useState<AccountState | null>(null);
  const [marketSnapshot,setMarketSnapshot]=useState<MarketSnapshot|null>(null);
  const [streamState,setStreamState]=useState<"connecting"|"live"|"reconnecting">("connecting");
  const [clock,setClock]=useState(Date.now());
  const [activity,setActivity]=useState<TradeActivity[]>([]);
  const [orders,setOrders]=useState<RestingOrder[]>([]);
  const [orderType,setOrderType]=useState<"market"|"limit">("market");
  const [reduceOnly,setReduceOnly]=useState(false);
  const [limitPrice,setLimitPrice]=useState("95000");
  const [showDeposit, setShowDeposit] = useState(false);
  const [depositAmount, setDepositAmount] = useState("1");
  const [depositStatus, setDepositStatus] = useState("Deposit native USDC on the settlement chain");
  const [showWithdraw, setShowWithdraw] = useState(false);
  const [withdrawAmount, setWithdrawAmount] = useState("100");
  const [withdrawStatus, setWithdrawStatus] = useState("Withdrawal gas is sponsored");
  const [paused, setPaused] = useState(false);
  const [quickSession,setQuickSession]=useState<QuickSession|null>(null);
  const [localPrivateKey,setLocalPrivateKey]=useState<string|null>(null);
  const [accountTab,setAccountTab]=useState<"positions"|"orders"|"trades"|"activity">("positions");
  const [priceHistory,setPriceHistory]=useState<Record<Market,number[]>>({BTC:[],ETH:[]});
  const [tradeBusy,setTradeBusy]=useState(false);
  const [closePercent,setClosePercent]=useState<Record<Market,number>>({BTC:100,ETH:100});

  async function requestQuote(signal?: AbortSignal) {
    return postJson<Quote>(`${API}/v1/quote`, { market, side, amount }, signal);
  }
  async function post(path: string, body: unknown) {
    return postJson(`${API}${path}`, body);
  }
  const accountReadGeneration=useRef(0),activeWalletAccount=useRef<string|null>(null);
  useEffect(()=>()=>{accountReadGeneration.current++;activeWalletAccount.current=null;},[]);
  async function refreshAccount(address: string) {
    const generation=++accountReadGeneration.current;
    const protocolRequest=optionalJson(`${INDEXER}/v1/protocol`);
    const activityRequest=optionalJson(`${INDEXER}/v1/account/${address}/activity?limit=30`);
    const ordersRequest=optionalJson(`${API}/v1/orders/${address}`);
    const state=await optionalJson<AccountState>(`${API}/v1/account/${address}`);
    const [protocol,history,orderHistory]=await Promise.all([protocolRequest,activityRequest,ordersRequest]);
    if(generation!==accountReadGeneration.current||activeWalletAccount.current?.toLowerCase()!==address.toLowerCase())return;
    if(state)setAccountState(state);
    if(protocol)setPaused(Boolean(protocol.paused));
    if(history)setActivity(history.items);
    if(orderHistory)setOrders(orderHistory.items);
  }
  useEffect(() => {
    if(!marketSnapshot){setQuote(null);return;}try{const live=marketSnapshot.markets[market];if(streamState!=="live"||clock-live.observedAtMs>2_500)throw new Error("Market data reconnecting");if(!(side==="buy"?live.canBuy:live.canSell))throw new Error(`Only exposure-reducing ${side==="buy"?"buys":"sells"} are available`);const pricing=marketSnapshot.pricing,spread=spreadFromWire(live),value=constructQuote({market,side,amount},{market,bid:BigInt(live.bid),ask:BigInt(live.ask),observedAtMs:live.observedAtMs,source:live.source,volatilityBps:live.volatilityBps},{BTC:BigInt(pricing.settled.BTC),ETH:BigInt(pricing.settled.ETH)},pricing.pending.map(item=>({market:item.market,delta:BigInt(item.delta)})),clock,crypto.randomUUID(),{maxNotional:BigInt(live.operatingMaxTradeNotional),baseSpreadBps:spread.totalBps,feeBps:BigInt(pricing.feeBps),toleranceBps:BigInt(pricing.toleranceBps),spread});setQuote({...quoteToWire(value),quoteId:undefined,indicative:true});setStatus(current=>["Live estimate","Reduced size limits","Market data reconnecting"].includes(current)||current.startsWith("Only exposure-reducing")?live.riskMode==="guarded"?"Reduced size limits":"Live estimate":current);}catch(error){setQuote(null);setStatus(error instanceof Error?error.message:"Quote unavailable");}
  }, [marketSnapshot,market,side,amount,streamState,clock]);
  useEffect(()=>{
    const stream=new EventSource(`${MARKET_STREAM}/v1/markets/stream`);stream.onopen=()=>setStreamState("live");stream.onerror=()=>setStreamState("reconnecting");stream.addEventListener("markets",event=>{try{const next=JSON.parse((event as MessageEvent).data) as MarketSnapshot;setMarketSnapshot(next);setPriceHistory(current=>({BTC:[...current.BTC,Number(BigInt(next.markets.BTC.mid))/1e6].slice(-120),ETH:[...current.ETH,Number(BigInt(next.markets.ETH.mid))/1e6].slice(-120)}));setStreamState("live");}catch{}});stream.addEventListener("stream-error",()=>setStreamState("reconnecting"));return()=>stream.close();
  },[]);
  useEffect(()=>{let active=true;for(const name of ["BTC","ETH"] as Market[])fetch(`${MARKET_STREAM}/v1/markets/history?market=${name}&limit=120`).then(response=>response.ok?response.json():null).then(value=>{if(!active||!value?.points)return;const prior=(value.points as Array<{mid:string}>).map(point=>Number(BigInt(point.mid))/1e6);setPriceHistory(current=>({...current,[name]:[...prior,...current[name]].slice(-120)}));}).catch(()=>{});return()=>{active=false};},[]);
  useEffect(()=>onWalletChange?.(account),[account,onWalletChange]);
  useEffect(()=>setStatus("Live estimate"),[market,side,amount,orderType,limitPrice,reduceOnly]);
  useEffect(()=>{const timer=setInterval(()=>setClock(Date.now()),500);return()=>clearInterval(timer);},[]);
  useEffect(()=>{let stopped=false;fetch(`${API}/v1/dev/wallet`).then(response=>response.ok?response.json():null).then(value=>{if(stopped||!value?.account||!value?.privateKey)return;setLocalPrivateKey(value.privateKey);activeWalletAccount.current=value.account;setAccount(value.account);void refreshAccount(value.account);}).catch(()=>{});return()=>{stopped=true;};},[]);
  useEffect(()=>{if(!account)return;const stream=new EventSource(`${INDEXER}/v1/updates/stream`);stream.addEventListener("indexed",event=>{try{const update=JSON.parse((event as MessageEvent).data) as {initial?:boolean;reset?:boolean;accounts?:string[]};if(update.initial||update.reset||update.accounts?.some(value=>value.toLowerCase()===account.toLowerCase()))void refreshAccount(account);}catch{}});return()=>stream.close();},[account]);
  useEffect(()=>{const provider=(window as unknown as {ethereum?:WalletProvider}).ethereum;if(!provider?.on||localPrivateKey)return;const accountsChanged=(value:unknown)=>{accountReadGeneration.current++;const next=Array.isArray(value)&&typeof value[0]==="string"?value[0]:null;activeWalletAccount.current=next;setAccount(next);setAccountState(null);setActivity([]);setOrders([]);setQuickSession(null);setStatus(next?"Wallet account changed":"Wallet disconnected");if(next)void refreshAccount(next);};const chainChanged=()=>{accountReadGeneration.current++;activeWalletAccount.current=null;setAccountState(null);setQuickSession(null);setStatus("Wallet network changed · reconnect to continue");};provider.on("accountsChanged",accountsChanged);provider.on("chainChanged",chainChanged);return()=>{provider.removeListener?.("accountsChanged",accountsChanged);provider.removeListener?.("chainChanged",chainChanged);};},[localPrivateKey]);

  async function wallet(): Promise<ConnectedWallet> {
    if(account&&localPrivateKey)return {account,privateKey:localPrivateKey};
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
    const currentAccounts=await ethereum.request({method:"eth_accounts"}) as string[];if(!currentAccounts[0])throw new Error("Wallet disconnected");accounts[0]=currentAccounts[0];activeWalletAccount.current=accounts[0];
    setAccount(accounts[0]);
    try{const stored=sessionStorage.getItem(`rfq-session:${accounts[0].toLowerCase()}`);const parsed=stored?JSON.parse(stored) as QuickSession:null;setQuickSession(current=>current?.account.toLowerCase()===accounts[0].toLowerCase()&&current.validUntil>Date.now()?current:parsed&&parsed.validUntil>Date.now()&&/^0x[0-9a-fA-F]{40}$/.test(parsed.sessionAddress)?parsed:null);}catch{setQuickSession(null);}
    void refreshAccount(accounts[0]);
    return { provider: ethereum, account: accounts[0] };
  }
  async function signTyped(connected: ConnectedWallet, prepared: { domain: Record<string, unknown>; types: Record<string, unknown>; intent: unknown }, primaryType: string) {
    if(connected.privateKey){const {Wallet}=await import("ethers");return new Wallet(connected.privateKey).signTypedData(prepared.domain,prepared.types as any,prepared.intent as Record<string,unknown>);}
    const provider=connected.provider;if(!provider)throw new Error("Wallet provider unavailable");
    const typedData = { domain: { ...prepared.domain, chainId: Number(prepared.domain.chainId) }, types: { EIP712Domain: [{ name: "name", type: "string" }, { name: "version", type: "string" }, { name: "chainId", type: "uint256" }, { name: "verifyingContract", type: "address" }], ...prepared.types }, primaryType, message: prepared.intent };
    return provider.request({ method: "eth_signTypedData_v4", params: [connected.account, JSON.stringify(typedData)] }) as Promise<string>;
  }
  async function approve() {
    if (!quote||tradeBusy) return;setTradeBusy(true);
    setStatus("Waiting for wallet…");
    try {
      const connected = await wallet();
      const current=await requestQuote();setQuote(current);
      const nonce = randomNonce();
      const prepared = await post("/v1/prepare", { quoteId: current.quoteId, account: connected.account, nonce, reduceOnly });
      let userSignature:string;
      if(quickSession?.privateKey&&quickSession.account.toLowerCase()===connected.account.toLowerCase()&&quickSession.validUntil>Date.now()&&Number(amount)<=2_500){setStatus("Signing with quick session…");const {SigningKey,TypedDataEncoder}=await import("ethers");const digest=TypedDataEncoder.hash(prepared.domain,prepared.types,prepared.intent);userSignature=new SigningKey(quickSession.privateKey).sign(digest).serialized;}
      else userSignature = await signTyped(connected, prepared, "TradeIntent");
      setStatus("Requesting two approvals…");
      const result = await post("/v1/approve", { quoteId: current.quoteId, account: connected.account, nonce, userSignature });
      setStatus(result.transaction ? `Executed in block ${result.transaction.blockNumber} · ${result.transaction.hash.slice(0, 10)}…` : "Approved by 2 of 3");
      await refreshAccount(connected.account);
    } catch (error) { setStatus(error instanceof Error ? error.message : "Unavailable"); }finally{setTradeBusy(false);}
  }
  async function placeLimit(){
    if(tradeBusy)return;setTradeBusy(true);
    setStatus("Waiting for limit-order signature…");
    try{const connected=await wallet(),nonce=randomNonce(),prepared=await post("/v1/orders/prepare",{account:connected.account,market,side,amount,limitPrice,durationSeconds:86_400,nonce,reduceOnly}),userSignature=await signTyped(connected,prepared,"TradeIntent");await post("/v1/orders",{orderId:prepared.orderId,userSignature});setStatus(`${side==="buy"?"Buy":"Sell"} limit open at ${dollars(prepared.intent.limitPrice)}`);await refreshAccount(connected.account);}catch(error){setStatus(error instanceof Error?error.message:"Limit order unavailable");}finally{setTradeBusy(false);}
  }
  async function cancelOrder(order:RestingOrder){
    setStatus("Waiting for cancellation signature…");try{const connected=await wallet(),prepared=await post(`/v1/orders/${order.orderId}/cancel/prepare`,{}),userSignature=await signTyped(connected,prepared,"CancelIntent"),result=await post(`/v1/orders/${order.orderId}/cancel`,{intent:prepared.intent,userSignature});setStatus(`Order cancelled in block ${result.transaction.blockNumber}`);await refreshAccount(connected.account);}catch(error){setStatus(error instanceof Error?error.message:"Cancellation unavailable");}
  }
  async function deposit() {
    setDepositStatus("Waiting for wallet…");
    try {
      const connected=await wallet(),config=await (await fetch(`${API}/v1/config`)).json();
      const {BrowserProvider,Contract,JsonRpcProvider,Wallet,parseUnits}=await import("ethers");
      const signer=connected.provider?await new BrowserProvider(connected.provider as never).getSigner(connected.account):connected.privateKey&&config.rpcUrl?new Wallet(connected.privateKey,new JsonRpcProvider(config.rpcUrl)):null;
      if(!signer||!config.tokenAddress||!config.clearingAddress)throw new Error("Settlement wallet or token configuration unavailable");
      const amount=parseUnits(depositAmount,6);if(amount<=0n)throw new Error("Deposit must be positive");
      const token=new Contract(config.tokenAddress,["function approve(address,uint256) returns(bool)","function allowance(address,address) view returns(uint256)"],signer),clearing=new Contract(config.clearingAddress,["function deposit(uint256)"],signer);
      if(BigInt(await token.allowance(connected.account,config.clearingAddress))<amount){setDepositStatus("Approve USDC in your wallet…");const approval=await (await token.approve(config.clearingAddress,amount)).wait();if(approval?.status!==1)throw new Error("USDC approval was not confirmed");}
      setDepositStatus("Confirm deposit in your wallet…");const receipt=await (await clearing.deposit(amount)).wait();if(receipt?.status!==1)throw new Error("Deposit was not confirmed");
      setDepositStatus(`Deposited ${depositAmount} USDC · block ${receipt.blockNumber}`);await refreshAccount(connected.account);
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
  async function closePosition(closeMarket:Market){
    const percent=closePercent[closeMarket];setStatus(`Getting an exact ${percent}% close quote…`);
    try{
      const connected=await wallet(),quote=await post("/v1/close/quote",{account:connected.account,market:closeMarket,percentBps:percent*100}),nonce=randomNonce();
      const prepared=await post("/v1/prepare",{quoteId:quote.quoteId,account:connected.account,nonce,reduceOnly:true});
      const userSignature=await signTyped(connected,prepared,"TradeIntent");setStatus("Requesting two approvals…");
      const result=await post("/v1/approve",{quoteId:quote.quoteId,account:connected.account,nonce,userSignature});setStatus(`Closed ${percent}% of ${closeMarket} in block ${result.transaction.blockNumber}`);await refreshAccount(connected.account);
    }catch(error){setStatus(error instanceof Error?error.message:"Close unavailable");}
  }
  async function emergencyClose(closeMarket:Market){
    setStatus("Waiting for emergency close signature…");
    try{
      const connected=await wallet(),prepared=await post("/v1/close/prepare",{account:connected.account,market:closeMarket,nonce:randomNonce()});
      const userSignature=await signTyped(connected,prepared,"CloseIntent");setStatus("Submitting conservative close…");
      const result=await post("/v1/close/execute",{intent:prepared.intent,userSignature});setStatus(`Closed ${closeMarket} in block ${result.transaction.blockNumber}`);await refreshAccount(connected.account);
    }catch(error){setStatus(error instanceof Error?error.message:"Emergency close unavailable");}
  }
  async function enableQuickTrading(){
    setStatus("Waiting for session approval…");
    try{
      const connected=await wallet();const {computeAddress}=await import("ethers");const privateKey=`0x${[...crypto.getRandomValues(new Uint8Array(32))].map(value=>value.toString(16).padStart(2,"0")).join("")}`,sessionAddress=computeAddress(privateKey);const prepared=await post("/v1/session/prepare",{account:connected.account,session:sessionAddress,marketMask:3,maxTradeAmount:"2500",maxCumulativeAmount:"10000",maxFee:"5",durationSeconds:28_800,nonce:randomNonce()});
      const userSignature=await signTyped(connected,{...prepared,intent:prepared.grant},"SessionGrant");setStatus("Activating sponsored session…");
      const result=await post("/v1/session/execute",{grant:prepared.grant,userSignature});const session={account:connected.account,sessionAddress,privateKey,validUntil:Number(result.validUntil)*1_000};sessionStorage.setItem(`rfq-session:${connected.account.toLowerCase()}`,JSON.stringify({account:session.account,sessionAddress,validUntil:session.validUntil}));setQuickSession(session);setStatus("Quick trading active in this tab for 8 hours");
    }catch(error){setStatus(error instanceof Error?error.message:"Session unavailable");}
  }
  async function disableQuickTrading(){
    if(!quickSession)return;
    setStatus("Waiting for session revocation…");
    try{
      const connected=await wallet();
      const config=await fetch(`${API}/v1/config`).then(response=>response.json());
      const sessionAddress=quickSession.sessionAddress,data=`0x1fa5d6a4${sessionAddress.slice(2).padStart(64,"0")}`;
      let hash:string;
      if(connected.privateKey){const {JsonRpcProvider,Wallet}=await import("ethers");const transaction=await new Wallet(connected.privateKey,new JsonRpcProvider(config.rpcUrl)).sendTransaction({to:config.clearingAddress,data});hash=transaction.hash;await transaction.wait();sessionStorage.removeItem(`rfq-session:${connected.account.toLowerCase()}`);setQuickSession(null);setStatus("Quick trading revoked on-chain");return;}
      else {const provider=connected.provider;if(!provider)throw new Error("Wallet provider unavailable");hash=await provider.request({method:"eth_sendTransaction",params:[{from:connected.account,to:config.clearingAddress,data}]}) as string;}
      setStatus(`Revocation submitted · ${hash.slice(0,10)}…`);
      for(let attempt=0;attempt<40;attempt++){
        const receipt=await connected.provider!.request({method:"eth_getTransactionReceipt",params:[hash]}) as {status?:string}|null;
        if(receipt?.status==="0x0")throw new Error("Session revocation reverted");
        if(receipt?.status==="0x1"){
          sessionStorage.removeItem(`rfq-session:${connected.account.toLowerCase()}`);setQuickSession(null);setStatus("Quick trading revoked on-chain");return;
        }
        await new Promise(resolve=>setTimeout(resolve,250));
      }
      setStatus(`Revocation pending · ${hash.slice(0,10)}…`);
    }catch(error){setStatus(error instanceof Error?error.message:"Session revocation unavailable");}
  }

  const live=marketSnapshot?.markets[market];
  const emptyPosition=(name:Market)=>({size:"0",entryPrice:"0",markPrice:marketSnapshot?.markets[name].mid??"0",notional:"0",unrealizedPnl:"0",accruedFunding:"0",lastFundingIndex:"0",estimatedLiquidationPrice:null});
  const shownAccount:AccountState=markAccount(accountState??{account:account??"",blockNumber:marketSnapshot?.blockNumber??0,collateral:"0",equity:"0",openingEquity:"0",unrealizedPnl:"0",accruedFunding:"0",grossNotional:"0",initialMargin:"0",maintenanceMargin:"0",availableMargin:"0",maintenanceBuffer:"0",marginRatioBps:null,effectiveLeverageBps:null,liquidatable:false,positions:{BTC:emptyPosition("BTC"),ETH:emptyPosition("ETH")}},marketSnapshot);
  const quoteAge=quote?Math.max(0,Date.now()-quote.observedAtMs):null;
  const parsedLimit=Number(limitPrice),currentMakerPrice=quote?Number(BigInt(quote.expectedPrice))/1e6:null,limitMarketable=currentMakerPrice!==null&&Number.isFinite(parsedLimit)&&(side==="buy"?currentMakerPrice<=parsedLimit:currentMakerPrice>=parsedLimit),limitDistanceBps=currentMakerPrice&&Number.isFinite(parsedLimit)?Math.abs(parsedLimit/currentMakerPrice-1)*10_000:null;
  return <section className="trading-workspace">
    <article className="trade-card order-ticket">
      <div className="ticket-heading"><div><small>ORDER ENTRY</small><strong><AssetIcon market={market}/>{market}-PERP</strong></div><span className={streamState}>{streamState==="live"?"Live":"Reconnecting"}</span></div>
      <div className="order-types"><button className={orderType==="market"?"active":""} onClick={()=>setOrderType("market")}>Market</button><button className={orderType==="limit"?"active":""} onClick={()=>{setOrderType("limit");if(live)setLimitPrice((Number(BigInt(live.mid))/1e6).toFixed(2));}}>Limit</button></div>
      {live?.riskMode!=="normal"&&<p className="risk-notice">{live?.riskMode==="guarded"?"Hedging is catching up. Trade sizes are temporarily reduced.":"Hedging is unavailable. Only trades that reduce market exposure can execute."}</p>}
      <label>Amount <span>USDC</span></label><div className="amount"><input aria-label="Trade amount" inputMode="decimal" value={amount} onChange={event => setAmount(event.target.value)} /><b>USDC</b></div>
      {orderType==="limit"&&<><label>Limit price <span>Good for 24 hours</span></label><div className="amount limit-amount"><input aria-label="Limit price" inputMode="decimal" value={limitPrice} onChange={event=>setLimitPrice(event.target.value)}/><b>USDC</b></div></>}
      <div className="sides"><button className={side === "buy" ? "buy active" : "buy"} onClick={() => setSide("buy")}>Buy</button><button className={side === "sell" ? "sell active" : "sell"} onClick={() => setSide("sell")}>Sell</button></div>
      <label className="order-option"><input type="checkbox" checked={reduceOnly} onChange={event=>setReduceOnly(event.target.checked)}/><span><b>Reduce only</b><small>Never increase or flip your position</small></span></label>
      <dl>{orderType==="market"?<><div><dt>Estimated price</dt><dd>{dollars(quote?.expectedPrice)}</dd></div><div><dt>Maximum fee</dt><dd>{dollars(quote?.fee)}</dd></div><div><dt>{side==="buy"?"Maximum":"Minimum"} accepted price</dt><dd>{dollars(quote?.worstPrice)}</dd></div></>:<><div><dt>Current maker {side==="buy"?"ask":"bid"}</dt><dd>{dollars(quote?.expectedPrice)}</dd></div><div><dt>Trigger</dt><dd className={limitMarketable?"positive":""}>{limitMarketable?"Marketable now":limitDistanceBps===null?"—":`${limitDistanceBps.toFixed(1)} bps away`}</dd></div><div><dt>Execution rule</dt><dd>{side==="buy"?"Ask ≤ limit":"Bid ≥ limit"}</dd></div><div><dt>Maximum fee</dt><dd>{dollars(quote?.fee)}</dd></div></>}</dl>
      <details className="price-details"><summary>Price details</summary><div><span>Oracle {side==="buy"?"ask":"bid"}<b>{dollars(side==="buy"?quote?.ask:quote?.bid)}</b></span><span>Adaptive spread<b>{quote?.spread?`${quote.spread.totalBps} bps`:"—"}</b></span><span>Inventory adjustment<b>{dollars(quote?.impactCharge)}</b></span><span>Price age<b>{quoteAge===null?"—":`${quoteAge} ms`}</b></span><span>Current maximum<b>{dollars(live?.operatingMaxTradeNotional)}</b></span></div></details>
      <button className={`submit ${side}`} disabled={!quote||tradeBusy} aria-busy={tradeBusy} onClick={orderType==="market"?approve:placeLimit}>{tradeBusy?"Submitting…":orderType==="market"?(side === "buy" ? "Buy" : "Sell"):`Place ${side}`} {tradeBusy?"":market}</button><p className="status" aria-live="polite"><i />{status}</p>
      <button className="depositToggle" onClick={() => setShowDeposit(value => !value)}>{showDeposit ? "Hide deposit" : "Deposit USDC"}</button>
      {showDeposit && <section className="depositPanel"><div className="depositGrid"><p>Native USDC on the settlement chain. Your wallet confirms approval and deposit.</p></div><label>Deposit amount</label><div className="amount compact"><input aria-label="Deposit amount" inputMode="decimal" value={depositAmount} onChange={event => setDepositAmount(event.target.value)} /><b>USDC</b></div><button className="route" onClick={deposit}>Approve & deposit</button><p className="status">{depositStatus}</p></section>}
      <button className="wallet trade-wallet" onClick={() => wallet().catch(error => setStatus(error instanceof Error ? error.message : "Wallet unavailable"))}>{account ? `${account.slice(0, 6)}…${account.slice(-4)}` : "Connect wallet"}</button>
      {account&&<button className={`depositToggle quickToggle ${quickSession?"active":""}`} onClick={quickSession?disableQuickTrading:enableQuickTrading}>{quickSession?"Revoke quick trading":"Enable quick trading"}</button>}
    </article>
    <aside className="portfolio-panel">
        <section className="market-stage"><header><div className="market-identity"><AssetIcon market={market}/><div><select aria-label="Market selector" value={market} onChange={event=>setMarket(event.target.value as Market)}><option value="BTC">BTC-PERP</option><option value="ETH">ETH-PERP</option></select><span>Perpetual · Cross margin</span></div></div><div className="market-last"><strong>{dollars(live?.mid)}</strong><span className={streamState}>{streamState==="live"?"Streaming":"Reconnecting"}</span></div><dl><div><dt>Oracle</dt><dd>{dollars(live?.mid)}</dd></div><div><dt>Bid</dt><dd>{dollars(live?.bid)}</dd></div><div><dt>Ask</dt><dd>{dollars(live?.ask)}</dd></div><div><dt>Funding APR</dt><dd>{live?ratio((BigInt(live.fundingApr)*10_000n/1_000_000_000_000n).toString()):"—"}</dd></div><div><dt>Quote spread</dt><dd>{live?`${live.baseSpreadBps} bps`:"—"}</dd></div></dl></header><PriceChart values={priceHistory[market].length>1?priceHistory[market]:[Number(BigInt(live?.mid??"0"))/1e6,Number(BigInt(live?.mid??"0"))/1e6]}/></section>
        <div className={`account-health ${shownAccount.liquidatable?"danger":""}`}><div><small>Account equity</small><strong>{dollars(shownAccount.equity)}</strong><span>{signedDollars(shownAccount.unrealizedPnl)} unrealized · {signedDollars(shownAccount.accruedFunding)} funding</span></div><div className="health-score"><small>Margin usage</small><strong>{ratio(shownAccount.marginRatioBps)}</strong><span>{leverage(shownAccount.effectiveLeverageBps)} effective leverage</span></div></div>
        <div className="risk-grid"><div><small>Collateral</small><strong>{dollars(shownAccount.collateral)}</strong></div><div><small>Available margin</small><strong className={BigInt(shownAccount.availableMargin)<0n?"negative":""}>{dollars(shownAccount.availableMargin)}</strong></div><div><small>Initial margin</small><strong>{dollars(shownAccount.initialMargin)}</strong></div><div><small>Maintenance margin</small><strong>{dollars(shownAccount.maintenanceMargin)}</strong></div><div><small>Liquidation buffer</small><strong className={BigInt(shownAccount.maintenanceBuffer)<0n?"negative":"positive"}>{dollars(shownAccount.maintenanceBuffer)}</strong></div><div><small>Gross exposure</small><strong>{dollars(shownAccount.grossNotional)}</strong></div></div>
        <nav className="account-tabs" aria-label="Account data"><button className={accountTab==="positions"?"active":""} onClick={()=>setAccountTab("positions")}>Positions</button><button className={accountTab==="orders"?"active":""} onClick={()=>setAccountTab("orders")}>Open orders</button><button className={accountTab==="trades"?"active":""} onClick={()=>setAccountTab("trades")}>Trade history</button><button className={accountTab==="activity"?"active":""} onClick={()=>setAccountTab("activity")}>Account history</button></nav>
        {accountTab==="positions"&&<>
        <div className="panel-heading compact-heading"><div><h2>Positions</h2><p>Cross margin · conservative exit marks</p></div><button onClick={()=>setShowWithdraw(value=>!value)}>{showWithdraw?"Close":"Withdraw"}</button></div>
        {showWithdraw&&<section className="depositPanel accountPanel"><label>Withdraw to connected wallet</label><div className="amount compact"><input aria-label="Withdrawal amount" inputMode="decimal" value={withdrawAmount} onChange={event=>setWithdrawAmount(event.target.value)}/><b>USDC</b></div><button className="route" onClick={withdraw}>Sign & withdraw</button><p className="status">{withdrawStatus}</p></section>}
        {paused&&(BigInt(shownAccount.positions.BTC.size)!==0n||BigInt(shownAccount.positions.ETH.size)!==0n)&&<section className="emergencyPanel"><strong>Trading paused</strong><span>Close at the verified directional oracle price.</span><div>{BigInt(shownAccount.positions.BTC.size)!==0n&&<button onClick={()=>emergencyClose("BTC")}>Close BTC</button>}{BigInt(shownAccount.positions.ETH.size)!==0n&&<button onClick={()=>emergencyClose("ETH")}>Close ETH</button>}</div></section>}
        <div className="position-list">{(["BTC","ETH"] as Market[]).map(name=>{const position=shownAccount.positions[name],open=BigInt(position.size)!==0n;return <article key={name}><div className="position-title"><strong>{name}-PERP</strong><div className="position-side"><span className={BigInt(position.size)>=0n?"positive":"negative"}>{open?`${BigInt(position.size)>0n?"Long":"Short"} ${base((BigInt(position.size)<0n?-BigInt(position.size):BigInt(position.size)).toString())}`:"No position"}</span>{open&&!paused&&<><select aria-label={`Percentage of ${name} position to close`} value={closePercent[name]} onChange={event=>setClosePercent(current=>({...current,[name]:Number(event.target.value)}))}><option value="25">25%</option><option value="50">50%</option><option value="75">75%</option><option value="100">100%</option></select><button onClick={()=>closePosition(name)}>Close</button></>}</div></div><div className="position-metrics"><span>Entry <b>{open?dollars(position.entryPrice):"—"}</b></span><span>Mark <b>{dollars(position.markPrice)}</b></span><span>Notional <b>{dollars(position.notional)}</b></span><span>uPnL <b className={BigInt(position.unrealizedPnl)>=0n?"positive":"negative"}>{signedDollars(position.unrealizedPnl)}</b></span><span>Funding <b className={BigInt(position.accruedFunding)>=0n?"positive":"negative"}>{signedDollars(position.accruedFunding)}</b></span><span>Est. liquidation <b>{open?dollars(position.estimatedLiquidationPrice??undefined):"—"}</b></span></div></article>})}</div></>}
        {accountTab==="orders"&&<>
        <div className="panel-heading compact-heading"><div><h2>Orders</h2><p>Signed conditional orders and execution status</p></div><span>{orders.length} shown</span></div>
        <div className="open-orders">{orders.length?orders.slice(0,12).map(order=><div key={order.orderId}><span><b>{order.side==="buy"?"Buy":"Sell"} {order.market} · {inputDollars(order.amount)}</b><small>{dollars(order.limitPrice)} limit · {dollars(order.maxFee)} max fee</small></span><em>{order.status}</em>{(order.status==="open"||order.status==="executing")?<button onClick={()=>cancelOrder(order)}>Cancel</button>:<i />}</div>):<p className="empty-row">No orders for this account.</p>}</div></>}
        {accountTab==="trades"&&<>
        <div className="panel-heading compact-heading"><div><h2>Trade history</h2><p>Execution, realized PnL, fees and finality</p></div><span>{activity.filter(item=>item.kind==="TradeExecuted"||item.kind==="PositionClosed").length} trades</span></div>
        <div className="account-trades">{activity.some(item=>item.kind==="TradeExecuted"||item.kind==="PositionClosed")?activity.filter(item=>item.kind==="TradeExecuted"||item.kind==="PositionClosed").slice(0,10).map(item=>{const delta=BigInt(item.payload.baseDelta),gross=item.payload.realizedPnl,net=item.payload.netRealizedPnl,entry=item.payload.entryPriceBefore;return <article key={`${item.tx_hash}:${item.log_index}`}><header><b>{delta>0n?"Buy":"Sell"} {item.market===0?"BTC":"ETH"}</b><span className={item.finality}>{item.finality}</span></header><div><span>Size <b>{base((delta<0n?-delta:delta).toString())}</b></span><span>Price <b>{dollars(item.payload.price)}</b></span><span>Notional <b>{dollars(item.payload.notional)}</b></span><span>Entry before <b>{entry===undefined||entry==="0"?"—":dollars(entry)}</b></span><span>Fee <b>{dollars(item.payload.fee??"0")}</b></span><span>Realized PnL <b className={gross===undefined?"":BigInt(gross)>=0n?"positive":"negative"}>{gross===undefined?"—":signedDollars(gross)}</b></span><span>Net after fees <b className={net===undefined?"":BigInt(net)>=0n?"positive":"negative"}>{net===undefined?"—":signedDollars(net)}</b></span><span>Position after <b>{item.payload.positionAfter===undefined?"—":base((BigInt(item.payload.positionAfter)<0n?-BigInt(item.payload.positionAfter):BigInt(item.payload.positionAfter)).toString())}</b></span></div><footer><time>{new Date(item.timestamp*1_000).toLocaleString()}</time><span>Block {item.block_number}</span><code title={item.tx_hash}>{item.tx_hash.slice(0,10)}…{item.tx_hash.slice(-6)}</code></footer></article>}):<p className="empty-row">No trades for this account.</p>}</div></>}
        {accountTab==="activity"&&<>
        <div className="panel-heading compact-heading"><div><h2>Account activity</h2><p>Deposits, funding, trades and risk events</p></div><span>{activity.length} shown</span></div>
        <div className="account-history">{activity.length?activity.slice(0,12).map(item=><div key={`${item.tx_hash}:${item.log_index}`}><span>{item.kind.replace(/([A-Z])/g," $1").trim()}</span><b>{item.market===null||item.market===undefined?"":item.market===0?"BTC":"ETH"}</b><time>{new Date(item.timestamp*1_000).toLocaleTimeString([],{hour:"2-digit",minute:"2-digit"})}</time></div>):<p>No account activity yet.</p>}</div></>}
    </aside>
  </section>;
}
