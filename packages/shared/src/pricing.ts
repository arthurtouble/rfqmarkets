export const USDC = 1_000_000n;
export const RATE = 1_000_000_000_000n;
export const BASE = 1_000_000_000_000_000_000n;
const K = { BTC: 10_000n, ETH: 12_000n, CROSS: 6_573n } as const;
export type Market = "BTC" | "ETH";
export type Exposure = Record<Market, bigint>;
export type QuoteRequest={market:Market;side:"buy"|"sell";amount:string};

export function parseUsdc(value: string): bigint {const [whole, fraction = ""] = value.split(".");return BigInt(whole) * USDC + BigInt((fraction + "000000").slice(0, 6));}
export function formatUsdc(value: bigint): string {const sign = value < 0n ? "-" : "",absolute = value < 0n ? -value : value;return `${sign}${absolute / USDC}.${(absolute % USDC).toString().padStart(6, "0")}`;}
function floorDiv(numerator: bigint, denominator: bigint): bigint {let quotient = numerator / denominator;if (numerator < 0n && numerator % denominator !== 0n) quotient -= 1n;return quotient;}
export function potential(exposure: Exposure): bigint {const numerator = K.BTC * exposure.BTC * exposure.BTC + 2n * K.CROSS * exposure.BTC * exposure.ETH + K.ETH * exposure.ETH * exposure.ETH;return floorDiv(numerator, 2n * RATE * USDC);}
export function impactCost(exposure: Exposure, market: Market, delta: bigint): bigint {const next = { ...exposure, [market]: exposure[market] + delta };return potential(next) - potential(exposure);}
export function requiredPendingImpact(settled:Exposure,pending:Array<{market:Market;delta:bigint}>,market:Market,delta:bigint):bigint {let btcLow=settled.BTC,btcHigh=settled.BTC,ethLow=settled.ETH,ethHigh=settled.ETH;for(const item of pending){if(item.market==="BTC"){if(item.delta<0n)btcLow+=item.delta;else btcHigh+=item.delta;}else{if(item.delta<0n)ethLow+=item.delta;else ethHigh+=item.delta;}}let greatest:bigint|undefined;for(const btc of [btcLow,btcHigh])for(const eth of [ethLow,ethHigh]){const cost=impactCost({BTC:btc,ETH:eth},market,delta);if(greatest===undefined||cost>greatest)greatest=cost;}return greatest??impactCost(settled,market,delta);}
export function ceilDiv(numerator: bigint, denominator: bigint): bigint {return numerator / denominator + (numerator % denominator === 0n ? 0n : 1n);}
export interface PriceSnapshot {market:Market;bid:bigint;ask:bigint;observedAtMs:number;source?:string;volatilityBps?:number;volatility?:{fastBps:number;mediumBps:number;slowBps:number;jumpBps:number;sampleCount:number}}
export interface SpreadBreakdown {baseBps:bigint;volatilityBps:bigint;toxicityBps:bigint;hedgeBps:bigint;basisBps:bigint;uncertaintyBps:bigint;totalBps:bigint;modelVersion:string}
export interface AdaptiveSpreadInputs {baseBps?:number;volatilityBps?:number;toxicityScoreBps?:number;hedgeCostBps?:number;hedgeLatencyMs?:number;venueBasisBps?:number;confidenceBps?:number;riskMode?:"normal"|"guarded"|"reduce_only";maxTotalBps?:number}
export interface Quote {quoteId:string;market:Market;side:"buy"|"sell";notional:bigint;delta:bigint;baseDelta:bigint;expectedPrice:bigint;worstPrice:bigint;fee:bigint;impactCharge:bigint;spread?:SpreadBreakdown;expiresAtMs:number;snapshot:PriceSnapshot}
export interface PricingParameters {maxNotional:bigint;baseSpreadBps:bigint;feeBps:bigint;toleranceBps:bigint;maxSnapshotAgeMs?:number;quoteLifetimeMs?:number;spread?:SpreadBreakdown}
export const launchPricing:PricingParameters={maxNotional:25_000n*USDC,baseSpreadBps:2n,feeBps:2n,toleranceBps:8n};
const bounded=(value:number,min:number,max:number)=>Math.min(max,Math.max(min,Number.isFinite(value)?value:0));
const bps=(value:number)=>BigInt(Math.ceil(Math.max(0,value)));
/** Deterministic market-wide quote-risk decomposition. */
export function adaptiveSpread(inputs:AdaptiveSpreadInputs={}):SpreadBreakdown{
  const baseBps=bps(bounded(inputs.baseBps??2,1,20));
  const observedVol=bounded(inputs.volatilityBps??0,0,2_000);
  const volatilityBps=bps(Math.min(40,observedVol/5));
  const toxicityBps=bps(Math.min(35,bounded(inputs.toxicityScoreBps??0,0,10_000)*35/10_000));
  const hedgeCost=bounded(inputs.hedgeCostBps??0,0,50),latency=bounded(inputs.hedgeLatencyMs??0,0,30_000);
  const hedgeMode=inputs.riskMode==="guarded"?4:inputs.riskMode==="reduce_only"?12:0;
  const hedgeBps=bps(Math.min(30,hedgeCost+hedgeMode+Math.sqrt(latency/1_000)*observedVol/25));
  const basisBps=bps(Math.min(25,Math.abs(bounded(inputs.venueBasisBps??0,-500,500))));
  const uncertaintyBps=bps(Math.min(20,bounded(inputs.confidenceBps??0,0,500)/2));
  const uncapped=baseBps+volatilityBps+toxicityBps+hedgeBps+basisBps+uncertaintyBps;
  const cap=BigInt(inputs.maxTotalBps??100),totalBps=uncapped>cap?cap:uncapped;
  return{baseBps,volatilityBps,toxicityBps,hedgeBps,basisBps,uncertaintyBps,totalBps,modelVersion:"adaptive-v1"};
}
export function marginRate(notional:bigint,initial:boolean){if(notional<=25_000n*USDC)return initial?2_000n:1_200n;if(notional<=100_000n*USDC)return initial?2_500n:1_500n;if(notional<=250_000n*USDC)return initial?3_300n:2_000n;if(notional<=1_000_000n*USDC)return initial?5_000n:3_000n;if(notional<=2_500_000n*USDC)return initial?6_700n:4_000n;if(notional<=5_000_000n*USDC)return initial?10_000n:6_000n;return 10_000n;}
export function constructQuote(request:QuoteRequest,snapshot:PriceSnapshot,settled:Exposure,pending:Array<{market:Market;delta:bigint}>,nowMs=Date.now(),quoteId=crypto.randomUUID(),parameters:PricingParameters=launchPricing,exactBaseDelta?:bigint):Quote {if(nowMs-snapshot.observedAtMs>(parameters.maxSnapshotAgeMs??2_000))throw new Error("oracle snapshot is stale");const mid=(snapshot.bid+snapshot.ask)/2n,requested=parseUsdc(request.amount),baseDelta=exactBaseDelta??(request.side==="buy"?requested*BASE/mid:-requested*BASE/mid);if(baseDelta===0n||(baseDelta>0n)!==(request.side==="buy"))throw new Error("invalid exact base direction");const absoluteBase=baseDelta<0n?-baseDelta:baseDelta,notional=exactBaseDelta===undefined?requested:absoluteBase*mid/BASE;if(notional<=0n||notional>parameters.maxNotional)throw new Error("amount exceeds market limit");const delta=baseDelta>0n?notional:-notional,rawImpact=requiredPendingImpact(settled,pending,request.market,delta),impactCharge=rawImpact>0n?rawImpact:0n,spread=parameters.spread,spreadBps=spread?.totalBps??parameters.baseSpreadBps,baseSpread=ceilDiv(notional*spreadBps,10_000n),fee=ceilDiv(notional*parameters.feeBps,10_000n),anchor=request.side==="buy"?snapshot.ask:snapshot.bid,premium=ceilDiv(anchor*(baseSpread+impactCharge),notional),expectedPrice=request.side==="buy"?anchor+premium:anchor-premium,tolerance=ceilDiv(expectedPrice*parameters.toleranceBps,10_000n),worstPrice=request.side==="buy"?expectedPrice+tolerance:expectedPrice-tolerance;return{quoteId,market:request.market,side:request.side,notional,delta,baseDelta,expectedPrice,worstPrice,fee,impactCharge,spread,expiresAtMs:nowMs+(parameters.quoteLifetimeMs??30_000),snapshot};}
