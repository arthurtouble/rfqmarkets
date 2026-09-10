export type Side = "buy" | "sell";
export type Market = "BTC" | "ETH";
export type SpreadBreakdown={baseBps:string;volatilityBps:string;toxicityBps:string;hedgeBps:string;basisBps:string;uncertaintyBps:string;totalBps:string;modelVersion:string};
export type Quote = { quoteId?: string; indicative?:boolean; expectedPrice: string; worstPrice: string; fee: string; impactCharge:string; spread?:SpreadBreakdown; expiresAtMs: number; bid:string; ask:string; observedAtMs:number };
export type WalletProvider = { request(args: { method: string; params?: unknown[] }): Promise<unknown>;on?(event:"accountsChanged"|"chainChanged",listener:(value:unknown)=>void):void;removeListener?(event:"accountsChanged"|"chainChanged",listener:(value:unknown)=>void):void };
export type AccountPosition = { size:string;entryPrice:string;markPrice:string;notional:string;unrealizedPnl:string;accruedFunding:string;lastFundingIndex:string;estimatedLiquidationPrice:string|null };
export type AccountState = { account:string;blockNumber:number;collateral:string;equity:string;openingEquity:string;unrealizedPnl:string;accruedFunding:string;grossNotional:string;initialMargin:string;maintenanceMargin:string;availableMargin:string;maintenanceBuffer:string;marginRatioBps:string|null;effectiveLeverageBps:string|null;liquidatable:boolean;positions:Record<Market,AccountPosition> };
export type MarketState = {market:Market;bid:string;ask:string;mid:string;observedAtMs:number;source:string;volatilityBps:number;volatility?:{fastBps:number;mediumBps:number;slowBps:number;jumpBps:number;sampleCount:number};baseSpreadBps:number;spread?:SpreadBreakdown;aggregateBase:string;fundingApr:string;fundingIndex:string;projectedFundingIndex:string;fundingTime:number;lastPriceTime:number;enabled:boolean;maxTradeNotional:string;maxMarketNotional:string;operatingMaxTradeNotional:string;riskMode:"normal"|"guarded"|"reduce_only";canBuy:boolean;canSell:boolean};
export type MarketSnapshot = {blockNumber:number;serverTimeMs:number;markets:Record<Market,MarketState>;pricing:{settled:Record<Market,string>;pending:Array<{market:Market;delta:string}>;baseSpreadBps:number;feeBps:number;toleranceBps:number}};
export type RestingOrder = {orderId:string;market:Market;side:Side;amount:string;baseDelta:string;limitPrice:string;maxFee:string;nonce:string;expiresAtMs:number;status:"open"|"executing"|"filled"|"cancelled"|"expired";transactionHash?:string;lastError?:string};
export type RiskMarket = { longBase: string; shortBase: string; netBase: string; longAccounts: number; shortAccounts: number };
export type Risk = { indexedBlock: number; accountCount: number; totalCollateral: string; markets: Record<Market, RiskMarket> };
export type Position = { account: string; collateral: string; positions: Record<Market, { size: string; entryPrice: string }> };
export type TradeActivity = {
  tx_hash: string; log_index: number; block_number: number; timestamp: number; kind: string; account: string; market: number;
  finality: "included" | "finalized"; payload: { baseDelta: string; price: string; fee: string };
};
