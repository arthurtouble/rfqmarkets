// Wire types for the API (services/api), market gateway and indexer.
// Amounts are decimal strings: USDC values in 1e6 units, base sizes in 1e18.

export type Side = "buy" | "sell";
export type Market = "BTC" | "ETH";
export const MARKETS: readonly Market[] = ["BTC", "ETH"];
export type RiskMode = "normal" | "guarded" | "reduce_only";

export type SpreadBreakdown = {
  baseBps: string; volatilityBps: string; toxicityBps: string; hedgeBps: string;
  basisBps: string; uncertaintyBps: string; totalBps: string; modelVersion: string;
};

export type Quote = {
  quoteId?: string; market?: Market; side?: Side; amount?: string; baseDelta?: string;
  expectedPrice: string; worstPrice: string; fee: string; impactCharge: string;
  spread?: SpreadBreakdown; expiresAtMs: number; bid: string; ask: string; observedAtMs: number;
};

export type MarketState = {
  market: Market; bid: string; ask: string; mid: string; observedAtMs: number; source: string;
  volatilityBps: number; baseSpreadBps: number; spread?: SpreadBreakdown;
  fundingApr: string; fundingIndex: string; projectedFundingIndex: string;
  enabled: boolean; maxTradeNotional: string; maxMarketNotional: string; operatingMaxTradeNotional: string;
  riskMode: RiskMode; canBuy: boolean; canSell: boolean;
};

export type MarketSnapshot = {
  blockNumber: number; serverTimeMs: number; markets: Record<Market, MarketState>;
  pricing: { settled: Record<Market, string>; pending: Array<{ market: Market; delta: string }>; baseSpreadBps: number; feeBps: number; toleranceBps: number };
};

export type AccountPosition = {
  size: string; entryPrice: string; markPrice: string; notional: string; unrealizedPnl: string;
  accruedFunding: string; lastFundingIndex: string; estimatedLiquidationPrice: string | null;
};

export type AccountState = {
  account: string; blockNumber: number; collateral: string; equity: string; openingEquity: string;
  unrealizedPnl: string; accruedFunding: string; grossNotional: string; initialMargin: string;
  maintenanceMargin: string; availableMargin: string; maintenanceBuffer: string;
  marginRatioBps: string | null; effectiveLeverageBps: string | null; liquidatable: boolean;
  positions: Record<Market, AccountPosition>;
};

export type OrderStatus = "open" | "executing" | "filled" | "cancelled" | "expired";
export type RestingOrder = {
  orderId: string; market: Market; side: Side; amount: string; baseDelta: string; limitPrice: string;
  maxFee: string; nonce: string; expiresAtMs: number; status: OrderStatus; transactionHash?: string; lastError?: string;
};

export type Activity = {
  tx_hash: string; log_index: number; block_number: number; timestamp: number; kind: string;
  account: string; market: number | null; finality: "included" | "finalized";
  payload: { baseDelta?: string; price?: string; fee?: string; amount?: string };
};

export type RiskMarket = { longBase: string; shortBase: string; netBase: string; longAccounts: number; shortAccounts: number };
export type Risk = { indexedBlock: number; accountCount: number; totalCollateral: string; markets: Record<Market, RiskMarket> };
export type PublicPosition = { account: string; collateral: string; positions: Record<Market, { size: string; entryPrice: string }> };
export type IndexerHealth = { ok: boolean; indexedBlock: number; finalizedBlock: number; headBlock: number; lag: number };
export type Protocol = { blockNumber: number; paused: boolean; resolutionRequired: boolean };

export type ChainConfig = {
  chainId: `0x${string}`; chainName: string; rpcUrl?: string;
  clearingAddress: `0x${string}`; tokenAddress?: `0x${string}`;
};

/** An EIP-712 payload prepared by the API for the user to sign. */
export type Prepared<I = Record<string, unknown>> = {
  domain: { name: string; version: string; chainId: string; verifyingContract: `0x${string}` };
  types: Record<string, Array<{ name: string; type: string }>>;
  intent: I;
};

export type Transaction = { hash: `0x${string}`; blockNumber: number };

export const marketFromIndex = (index: number | null | undefined): Market | null =>
  index === 0 ? "BTC" : index === 1 ? "ETH" : null;
