import { useEffect, useState } from "react";
import { API, INDEXER, MARKET_STREAM, base, dollars } from "./config.js";
import type { AccountState, Market, MarketSnapshot, Quote, RestingOrder, Side, TradeActivity, WalletProvider } from "./types.js";
import { constructQuote, marginRate } from "../../../packages/shared/src/pricing.js";
import { quoteToWire } from "../../../packages/shared/src/wire.js";

const chains = { 1: "Ethereum", 42161: "Arbitrum", 10: "Optimism", 8453: "Base" } as const;
type QuickSession={account:string;privateKey:string;validUntil:number};
type ConnectedWallet={account:string;provider?:WalletProvider;privateKey?:string};
const signedDollars=(value?:string)=>value===undefined?"—":`${BigInt(value)>0n?"+":""}${dollars(value)}`;
const ratio=(bps?:string|null)=>bps===null||bps===undefined?"—":`${(Number(bps)/100).toFixed(2)}%`;
const leverage=(bps?:string|null)=>bps===null||bps===undefined?"—":`${(Number(bps)/10_000).toFixed(2)}×`;
const inputDollars=(value:string)=>new Intl.NumberFormat("en-US",{style:"currency",currency:"USD",maximumFractionDigits:2}).format(Number(value));
const abs=(value:bigint)=>value<0n?-value:value;
function markAccount(state:AccountState,snapshot:MarketSnapshot|null):AccountState{
  if(!snapshot)return state;let unrealized=0n,funding=0n,gross=0n,initial=0n,maintenance=0n;const positions={...state.positions};
  for(const market of ["BTC","ETH"] as Market[]){const position=state.positions[market],size=BigInt(position.size),live=snapshot.markets[market],mark=size>=0n?BigInt(live.bid):BigInt(live.ask),notional=abs(size)*BigInt(live.ask)/10n**18n,pnl=size>0n?abs(size)*(mark-BigInt(position.entryPrice))/10n**18n:size<0n?abs(size)*(BigInt(position.entryPrice)-mark)/10n**18n:0n,accrued=-size*(BigInt(live.projectedFundingIndex)-BigInt(position.lastFundingIndex))/10n**18n;unrealized+=pnl;funding+=accrued;gross+=notional;initial+=notional*marginRate(notional,true)/10_000n;maintenance+=notional*marginRate(notional,false)/10_000n;positions[market]={...position,markPrice:mark.toString(),notional:notional.toString(),unrealizedPnl:pnl.toString(),accruedFunding:accrued.toString()};}
  const collateral=BigInt(state.collateral),equity=collateral+unrealized+funding,openingEquity=collateral+funding+(unrealized<0n?unrealized:0n);return {...state,blockNumber:snapshot.blockNumber,positions,unrealizedPnl:unrealized.toString(),accruedFunding:funding.toString(),grossNotional:gross.toString(),equity:equity.toString(),openingEquity:openingEquity.toString(),initialMargin:initial.toString(),maintenanceMargin:maintenance.toString(),availableMargin:(openingEquity-initial).toString(),maintenanceBuffer:(equity-maintenance).toString(),marginRatioBps:equity>0n?(maintenance*10_000n/equity).toString():null,effectiveLeverageBps:equity>0n?(gross*10_000n/equity).toString():null,liquidatable:equity<maintenance};
}

function PriceChart({values}:{values:number[]}){
  const width=800,height=230,pad=12,min=Math.min(...values),max=Math.max(...values),range=Math.max(max-min,.01),points=values.map((value,index)=>`${pad+index*(width-pad*2)/Math.max(1,values.length-1)},${pad+(max-value)*(height-pad*2)/range}`).join(" "),first=values[0]??0,last=values.at(-1)??0,up=last>=first;
  return <div className="price-chart"><svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`Live price chart, ${up?"up":"down"} ${Math.abs(last-first).toFixed(2)} dollars`} preserveAspectRatio="none"><defs><linearGradient id="chartFill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor={up?"#8aa2ff":"#ff7085"} stopOpacity=".22"/><stop offset="1" stopColor={up?"#8aa2ff":"#ff7085"} stopOpacity="0"/></linearGradient></defs><path d={`M ${points.replaceAll(" "," L ")} L ${width-pad},${height-pad} L ${pad},${height-pad} Z`} fill="url(#chartFill)"/><polyline points={points} fill="none" stroke={up?"#9fb0ff":"#ff7085"} strokeWidth="2.2" vectorEffect="non-scaling-stroke"/></svg><span>Live session</span></div>;
}

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
  const [sourceChain, setSourceChain] = useState<keyof typeof chains>(1);
  const [sourceToken, setSourceToken] = useState<"ETH" | "USDC" | "USDT">("ETH");
  const [depositAmount, setDepositAmount] = useState("1");
  const [depositStatus, setDepositStatus] = useState("Local route simulator");
  const [showWithdraw, setShowWithdraw] = useState(false);
  const [withdrawAmount, setWithdrawAmount] = useState("100");
  const [withdrawStatus, setWithdrawStatus] = useState("Withdrawal gas is sponsored");
  const [paused, setPaused] = useState(false);
  const [quickSession,setQuickSession]=useState<QuickSession|null>(null);
  const [localPrivateKey,setLocalPrivateKey]=useState<string|null>(null);
  const [accountTab,setAccountTab]=useState<"positions"|"orders"|"trades"|"activity">("positions");
  const [priceHistory,setPriceHistory]=useState<Record<Market,number[]>>({BTC:[],ETH:[]});

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
    const activityRequest=fetch(`${INDEXER}/v1/account/${address}/activity?limit=30`).then(response=>response.ok?response.json():null).catch(()=>null);
    const ordersRequest=fetch(`${API}/v1/orders/${address}`).then(response=>response.ok?response.json():null).catch(()=>null);
    const response = await fetch(`${API}/v1/account/${address}`);
    if (response.ok) setAccountState(await response.json());
    const protocol=await protocolRequest;if(protocol)setPaused(Boolean(protocol.paused));
    const history=await activityRequest;if(history)setActivity(history.items);
    const orderHistory=await ordersRequest;if(orderHistory)setOrders(orderHistory.items);
  }
  const randomNonce=()=>BigInt(`0x${[...crypto.getRandomValues(new Uint8Array(32))].map(value => value.toString(16).padStart(2, "0")).join("")}`).toString();
  useEffect(() => {
    if(!marketSnapshot){setQuote(null);return;}try{const live=marketSnapshot.markets[market];if(streamState!=="live"||clock-live.observedAtMs>2_500)throw new Error("Market data reconnecting");if(!(side==="buy"?live.canBuy:live.canSell))throw new Error(`Only exposure-reducing ${side==="buy"?"buys":"sells"} are available`);const pricing=marketSnapshot.pricing,value=constructQuote({market,side,amount},{market,bid:BigInt(live.bid),ask:BigInt(live.ask),observedAtMs:live.observedAtMs,source:live.source,volatilityBps:live.volatilityBps},{BTC:BigInt(pricing.settled.BTC),ETH:BigInt(pricing.settled.ETH)},pricing.pending.map(item=>({market:item.market,delta:BigInt(item.delta)})),clock,crypto.randomUUID(),{maxNotional:BigInt(live.operatingMaxTradeNotional),baseSpreadBps:BigInt(live.baseSpreadBps),feeBps:BigInt(pricing.feeBps),toleranceBps:BigInt(pricing.toleranceBps)});setQuote({...quoteToWire(value),quoteId:undefined,indicative:true});setStatus(current=>["Waiting for wallet…","Requesting two approvals…","No browser wallet detected"].includes(current)||current.startsWith("Executed")?current:live.riskMode==="guarded"?"Reduced size limits":"Live estimate");}catch(error){setQuote(null);setStatus(error instanceof Error?error.message:"Quote unavailable");}
  }, [marketSnapshot,market,side,amount,streamState,clock]);
  useEffect(()=>{
    const stream=new EventSource(`${MARKET_STREAM}/v1/markets/stream`);stream.onopen=()=>setStreamState("live");stream.onerror=()=>setStreamState("reconnecting");stream.addEventListener("markets",event=>{try{const next=JSON.parse((event as MessageEvent).data) as MarketSnapshot;setMarketSnapshot(next);setPriceHistory(current=>({BTC:[...current.BTC,Number(BigInt(next.markets.BTC.mid))/1e6].slice(-120),ETH:[...current.ETH,Number(BigInt(next.markets.ETH.mid))/1e6].slice(-120)}));setStreamState("live");}catch{}});stream.addEventListener("stream-error",()=>setStreamState("reconnecting"));return()=>stream.close();
  },[]);
  useEffect(()=>onWalletChange?.(account),[account,onWalletChange]);
  useEffect(()=>{const timer=setInterval(()=>setClock(Date.now()),500);return()=>clearInterval(timer);},[]);
  useEffect(()=>{let stopped=false;fetch(`${API}/v1/dev/wallet`).then(response=>response.ok?response.json():null).then(value=>{if(stopped||!value?.account||!value?.privateKey)return;setLocalPrivateKey(value.privateKey);setAccount(value.account);void refreshAccount(value.account);}).catch(()=>{});return()=>{stopped=true;};},[]);
  useEffect(()=>{if(!account)return;const stream=new EventSource(`${INDEXER}/v1/updates/stream`);stream.addEventListener("indexed",event=>{try{const update=JSON.parse((event as MessageEvent).data) as {initial?:boolean;reset?:boolean;accounts?:string[]};if(update.initial||update.reset||update.accounts?.some(value=>value.toLowerCase()===account.toLowerCase()))void refreshAccount(account);}catch{}});return()=>stream.close();},[account]);

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
    setAccount(accounts[0]);
    try{const stored=sessionStorage.getItem(`rfq-session:${accounts[0].toLowerCase()}`);const parsed=stored?JSON.parse(stored) as QuickSession:null;setQuickSession(parsed&&parsed.validUntil>Date.now()?parsed:null);}catch{setQuickSession(null);}
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
    if (!quote) return;
    setStatus("Waiting for wallet…");
    try {
      const connected = await wallet();
      const current=await requestQuote();setQuote(current);
      const nonce = randomNonce();
      const prepared = await post("/v1/prepare", { quoteId: current.quoteId, account: connected.account, nonce, reduceOnly });
      let userSignature:string;
      if(quickSession&&quickSession.account.toLowerCase()===connected.account.toLowerCase()&&quickSession.validUntil>Date.now()&&Number(amount)<=2_500){setStatus("Signing with quick session…");const {SigningKey,TypedDataEncoder}=await import("ethers");const digest=TypedDataEncoder.hash(prepared.domain,prepared.types,prepared.intent);userSignature=new SigningKey(quickSession.privateKey).sign(digest).serialized;}
      else userSignature = await signTyped(connected, prepared, "TradeIntent");
      setStatus("Requesting two approvals…");
      const result = await post("/v1/approve", { quoteId: current.quoteId, account: connected.account, nonce, userSignature });
      setStatus(result.transaction ? `Executed in block ${result.transaction.blockNumber} · ${result.transaction.hash.slice(0, 10)}…` : "Approved by 2 of 3");
      await refreshAccount(connected.account);
    } catch (error) { setStatus(error instanceof Error ? error.message : "Unavailable"); }
  }
  async function placeLimit(){
    setStatus("Waiting for limit-order signature…");
    try{const connected=await wallet(),nonce=randomNonce(),prepared=await post("/v1/orders/prepare",{account:connected.account,market,side,amount,limitPrice,durationSeconds:86_400,nonce,reduceOnly}),userSignature=await signTyped(connected,prepared,"TradeIntent");await post("/v1/orders",{orderId:prepared.orderId,userSignature});setStatus(`${side==="buy"?"Buy":"Sell"} limit open at ${dollars(prepared.intent.limitPrice)}`);await refreshAccount(connected.account);}catch(error){setStatus(error instanceof Error?error.message:"Limit order unavailable");}
  }
  async function cancelOrder(order:RestingOrder){
    setStatus("Waiting for cancellation signature…");try{const connected=await wallet(),prepared=await post(`/v1/orders/${order.orderId}/cancel/prepare`,{}),userSignature=await signTyped(connected,prepared,"CancelIntent"),result=await post(`/v1/orders/${order.orderId}/cancel`,{intent:prepared.intent,userSignature});setStatus(`Order cancelled in block ${result.transaction.blockNumber}`);await refreshAccount(connected.account);}catch(error){setStatus(error instanceof Error?error.message:"Cancellation unavailable");}
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
  async function closePosition(closeMarket:Market){
    setStatus("Getting an exact close quote…");
    try{
      const connected=await wallet(),quote=await post("/v1/close/quote",{account:connected.account,market:closeMarket}),nonce=randomNonce();
      const prepared=await post("/v1/prepare",{quoteId:quote.quoteId,account:connected.account,nonce,reduceOnly:true});
      const userSignature=await signTyped(connected,prepared,"TradeIntent");setStatus("Requesting two approvals…");
      const result=await post("/v1/approve",{quoteId:quote.quoteId,account:connected.account,nonce,userSignature});setStatus(`Closed ${closeMarket} in block ${result.transaction.blockNumber}`);await refreshAccount(connected.account);
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
      <div className="ticket-heading"><div><small>ORDER ENTRY</small><strong>{market}-PERP</strong></div><span className={streamState}>{streamState==="live"?"Live":"Reconnecting"}</span></div>
      <div className="order-types"><button className={orderType==="market"?"active":""} onClick={()=>setOrderType("market")}>Market</button><button className={orderType==="limit"?"active":""} onClick={()=>{setOrderType("limit");if(live)setLimitPrice((Number(BigInt(live.mid))/1e6).toFixed(2));}}>Limit</button></div>
      {live?.riskMode!=="normal"&&<p className="risk-notice">{live?.riskMode==="guarded"?"Hedging is catching up. Trade sizes are temporarily reduced.":"Hedging is unavailable. Only trades that reduce market exposure can execute."}</p>}
      <label>Amount <span>USDC</span></label><div className="amount"><input aria-label="Trade amount" inputMode="decimal" value={amount} onChange={event => setAmount(event.target.value)} /><b>USDC</b></div>
      {orderType==="limit"&&<><label>Limit price <span>Good for 24 hours</span></label><div className="amount limit-amount"><input aria-label="Limit price" inputMode="decimal" value={limitPrice} onChange={event=>setLimitPrice(event.target.value)}/><b>USDC</b></div></>}
      <div className="sides"><button className={side === "buy" ? "buy active" : "buy"} onClick={() => setSide("buy")}>Buy</button><button className={side === "sell" ? "sell active" : "sell"} onClick={() => setSide("sell")}>Sell</button></div>
      <label className="order-option"><input type="checkbox" checked={reduceOnly} onChange={event=>setReduceOnly(event.target.checked)}/><span><b>Reduce only</b><small>Never increase or flip your position</small></span></label>
      <dl>{orderType==="market"?<><div><dt>Estimated price</dt><dd>{dollars(quote?.expectedPrice)}</dd></div><div><dt>Maximum fee</dt><dd>{dollars(quote?.fee)}</dd></div><div><dt>{side==="buy"?"Maximum":"Minimum"} accepted price</dt><dd>{dollars(quote?.worstPrice)}</dd></div></>:<><div><dt>Current maker {side==="buy"?"ask":"bid"}</dt><dd>{dollars(quote?.expectedPrice)}</dd></div><div><dt>Trigger</dt><dd className={limitMarketable?"positive":""}>{limitMarketable?"Marketable now":limitDistanceBps===null?"—":`${limitDistanceBps.toFixed(1)} bps away`}</dd></div><div><dt>Execution rule</dt><dd>{side==="buy"?"Ask ≤ limit":"Bid ≥ limit"}</dd></div><div><dt>Maximum fee</dt><dd>{dollars(quote?.fee)}</dd></div></>}</dl>
      <details className="price-details"><summary>Price details</summary><div><span>Oracle {side==="buy"?"ask":"bid"}<b>{dollars(side==="buy"?quote?.ask:quote?.bid)}</b></span><span>Inventory adjustment<b>{dollars(quote?.impactCharge)}</b></span><span>Price age<b>{quoteAge===null?"—":`${quoteAge} ms`}</b></span><span>Current maximum<b>{dollars(live?.operatingMaxTradeNotional)}</b></span></div></details>
      <button className={`submit ${side}`} disabled={!quote} onClick={orderType==="market"?approve:placeLimit}>{orderType==="market"?(side === "buy" ? "Buy" : "Sell"):`Place ${side}`} {market}</button><p className="status"><i />{status}</p>
      <button className="depositToggle" onClick={() => setShowDeposit(value => !value)}>{showDeposit ? "Hide deposit" : "Deposit from any chain"}</button>
      {showDeposit && <section className="depositPanel"><div className="depositGrid"><label>From<select value={sourceChain} onChange={event => setSourceChain(Number(event.target.value) as keyof typeof chains)}>{Object.entries(chains).map(([id, name]) => <option value={id} key={id}>{name}</option>)}</select></label><label>Asset<select value={sourceToken} onChange={event => setSourceToken(event.target.value as "ETH" | "USDC" | "USDT")}><option>ETH</option><option>USDC</option><option>USDT</option></select></label></div><label>Deposit amount</label><div className="amount compact"><input aria-label="Deposit amount" inputMode="decimal" value={depositAmount} onChange={event => setDepositAmount(event.target.value)} /><b>{sourceToken}</b></div><button className="route" onClick={deposit}>Route & deposit</button><p className="status">{depositStatus}</p></section>}
      <button className="wallet trade-wallet" onClick={() => wallet().catch(error => setStatus(error instanceof Error ? error.message : "Wallet unavailable"))}>{account ? `${account.slice(0, 6)}…${account.slice(-4)}` : "Connect wallet"}</button>
      {account&&<button className={`depositToggle quickToggle ${quickSession?"active":""}`} onClick={quickSession?disableQuickTrading:enableQuickTrading}>{quickSession?"Revoke quick trading":"Enable quick trading"}</button>}
    </article>
    <aside className="portfolio-panel">
        <section className="market-stage"><header><div className="market-identity"><select aria-label="Market selector" value={market} onChange={event=>setMarket(event.target.value as Market)}><option value="BTC">BTC-PERP</option><option value="ETH">ETH-PERP</option></select><span>Perpetual · Cross</span></div><div className="market-last"><strong>{dollars(live?.mid)}</strong><span className={streamState}>{streamState==="live"?"Streaming":"Reconnecting"}</span></div><dl><div><dt>Oracle</dt><dd>{dollars(live?.mid)}</dd></div><div><dt>Bid</dt><dd>{dollars(live?.bid)}</dd></div><div><dt>Ask</dt><dd>{dollars(live?.ask)}</dd></div><div><dt>Funding APR</dt><dd>{live?ratio((BigInt(live.fundingApr)*10_000n/1_000_000_000_000n).toString()):"—"}</dd></div></dl></header><PriceChart values={priceHistory[market].length>1?priceHistory[market]:[Number(BigInt(live?.mid??"0"))/1e6,Number(BigInt(live?.mid??"0"))/1e6]}/></section>
        <div className={`account-health ${shownAccount.liquidatable?"danger":""}`}><div><small>Account equity</small><strong>{dollars(shownAccount.equity)}</strong><span>{signedDollars(shownAccount.unrealizedPnl)} unrealized · {signedDollars(shownAccount.accruedFunding)} funding</span></div><div className="health-score"><small>Margin usage</small><strong>{ratio(shownAccount.marginRatioBps)}</strong><span>{leverage(shownAccount.effectiveLeverageBps)} effective leverage</span></div></div>
        <div className="risk-grid"><div><small>Collateral</small><strong>{dollars(shownAccount.collateral)}</strong></div><div><small>Available margin</small><strong className={BigInt(shownAccount.availableMargin)<0n?"negative":""}>{dollars(shownAccount.availableMargin)}</strong></div><div><small>Initial margin</small><strong>{dollars(shownAccount.initialMargin)}</strong></div><div><small>Maintenance margin</small><strong>{dollars(shownAccount.maintenanceMargin)}</strong></div><div><small>Liquidation buffer</small><strong className={BigInt(shownAccount.maintenanceBuffer)<0n?"negative":"positive"}>{dollars(shownAccount.maintenanceBuffer)}</strong></div><div><small>Gross exposure</small><strong>{dollars(shownAccount.grossNotional)}</strong></div></div>
        <nav className="account-tabs" aria-label="Account data"><button className={accountTab==="positions"?"active":""} onClick={()=>setAccountTab("positions")}>Positions</button><button className={accountTab==="orders"?"active":""} onClick={()=>setAccountTab("orders")}>Open orders</button><button className={accountTab==="trades"?"active":""} onClick={()=>setAccountTab("trades")}>Trade history</button><button className={accountTab==="activity"?"active":""} onClick={()=>setAccountTab("activity")}>Account history</button></nav>
        {accountTab==="positions"&&<>
        <div className="panel-heading compact-heading"><div><h2>Positions</h2><p>Cross margin · conservative exit marks</p></div><button onClick={()=>setShowWithdraw(value=>!value)}>{showWithdraw?"Close":"Withdraw"}</button></div>
        {showWithdraw&&<section className="depositPanel accountPanel"><label>Withdraw to connected wallet</label><div className="amount compact"><input aria-label="Withdrawal amount" inputMode="decimal" value={withdrawAmount} onChange={event=>setWithdrawAmount(event.target.value)}/><b>USDC</b></div><button className="route" onClick={withdraw}>Sign & withdraw</button><p className="status">{withdrawStatus}</p></section>}
        {paused&&(BigInt(shownAccount.positions.BTC.size)!==0n||BigInt(shownAccount.positions.ETH.size)!==0n)&&<section className="emergencyPanel"><strong>Trading paused</strong><span>Close at the verified directional oracle price.</span><div>{BigInt(shownAccount.positions.BTC.size)!==0n&&<button onClick={()=>emergencyClose("BTC")}>Close BTC</button>}{BigInt(shownAccount.positions.ETH.size)!==0n&&<button onClick={()=>emergencyClose("ETH")}>Close ETH</button>}</div></section>}
        <div className="position-list">{(["BTC","ETH"] as Market[]).map(name=>{const position=shownAccount.positions[name],open=BigInt(position.size)!==0n;return <article key={name}><div className="position-title"><strong>{name}-PERP</strong><div className="position-side"><span className={BigInt(position.size)>=0n?"positive":"negative"}>{open?`${BigInt(position.size)>0n?"Long":"Short"} ${base((BigInt(position.size)<0n?-BigInt(position.size):BigInt(position.size)).toString())}`:"No position"}</span>{open&&!paused&&<button onClick={()=>closePosition(name)}>Close</button>}</div></div><div className="position-metrics"><span>Entry <b>{open?dollars(position.entryPrice):"—"}</b></span><span>Mark <b>{dollars(position.markPrice)}</b></span><span>Notional <b>{dollars(position.notional)}</b></span><span>uPnL <b className={BigInt(position.unrealizedPnl)>=0n?"positive":"negative"}>{signedDollars(position.unrealizedPnl)}</b></span><span>Funding <b className={BigInt(position.accruedFunding)>=0n?"positive":"negative"}>{signedDollars(position.accruedFunding)}</b></span><span>Est. liquidation <b>{open?dollars(position.estimatedLiquidationPrice??undefined):"—"}</b></span></div></article>})}</div></>}
        {accountTab==="orders"&&<>
        <div className="panel-heading compact-heading"><div><h2>Orders</h2><p>Signed conditional orders and execution status</p></div><span>{orders.length} shown</span></div>
        <div className="open-orders">{orders.length?orders.slice(0,12).map(order=><div key={order.orderId}><span><b>{order.side==="buy"?"Buy":"Sell"} {order.market} · {inputDollars(order.amount)}</b><small>{dollars(order.limitPrice)} limit · {dollars(order.maxFee)} max fee</small></span><em>{order.status}</em>{(order.status==="open"||order.status==="executing")?<button onClick={()=>cancelOrder(order)}>Cancel</button>:<i />}</div>):<p className="empty-row">No orders for this account.</p>}</div></>}
        {accountTab==="trades"&&<>
        <div className="panel-heading compact-heading"><div><h2>Trade history</h2><p>Final execution price, size and fee</p></div><span>{activity.filter(item=>item.kind==="TradeExecuted").length} trades</span></div>
        <div className="account-trades">{activity.some(item=>item.kind==="TradeExecuted")?activity.filter(item=>item.kind==="TradeExecuted").slice(0,10).map(item=><div key={`${item.tx_hash}:${item.log_index}`}><b>{BigInt(item.payload.baseDelta)>0n?"Buy":"Sell"} {item.market===0?"BTC":"ETH"}</b><span>{base((BigInt(item.payload.baseDelta)<0n?-BigInt(item.payload.baseDelta):BigInt(item.payload.baseDelta)).toString())} @ {dollars(item.payload.price)}</span><small>{dollars(item.payload.fee)} fee</small></div>):<p className="empty-row">No trades for this account.</p>}</div></>}
        {accountTab==="activity"&&<>
        <div className="panel-heading compact-heading"><div><h2>Account activity</h2><p>Deposits, funding, trades and risk events</p></div><span>{activity.length} shown</span></div>
        <div className="account-history">{activity.length?activity.slice(0,12).map(item=><div key={`${item.tx_hash}:${item.log_index}`}><span>{item.kind.replace(/([A-Z])/g," $1").trim()}</span><b>{item.market===null||item.market===undefined?"":item.market===0?"BTC":"ETH"}</b><time>{new Date(item.timestamp*1_000).toLocaleTimeString([],{hour:"2-digit",minute:"2-digit"})}</time></div>):<p>No account activity yet.</p>}</div></>}
    </aside>
  </section>;
}
