// Wire types for the API (services/api), market gateway and indexer.
// Amounts are decimal strings: USDC values in 1e6 units, base sizes in 1e18.

export type Side = "buy" | "sell";
/**
 * A market symbol. Markets are registered on chain by governance, so any
 * symbol the API lists is valid; use `useMarketList()` (data/markets.ts) for
 * the live list instead of a hard-coded one.
 */
export type Market = string;
/** The launch markets: the fallback list before `/v1/config` has loaded. */
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
  /** Contract index (session `marketMask` bit). Absent from older servers. */
  index?: number;
  /** Per-market margin multiplier on the base tiers (10_000 = 1x, 2_500 = 0.25x). */
  marginScaleBps?: number;
  /** Leverage the first tier's scaled initial margin allows (20 at 2_500). */
  maxLeverage?: number;
  /** First-tier scaled margin rates, in bps of notional. */
  initialMarginBps?: number;
  maintenanceMarginBps?: number;
};

/** A market without a price is left out of `markets` (and `settled`). */
export type MarketSnapshot = {
  blockNumber: number; serverTimeMs: number; markets: Record<Market, MarketState>;
  pricing: { settled: Record<Market, string>; pending: Array<{ market: Market; delta: string }>; baseSpreadBps: number; feeBps: number; toleranceBps: number };
};

export type AccountPosition = {
  size: string; entryPrice: string; markPrice: string; notional: string; unrealizedPnl: string;
  accruedFunding: string; lastFundingIndex: string; estimatedLiquidationPrice: string | null;
  initialMargin?: string; maintenanceMargin?: string;
};

export type AccountState = {
  account: string; blockNumber: number; collateral: string; equity: string; openingEquity: string;
  unrealizedPnl: string; accruedFunding: string; grossNotional: string; initialMargin: string;
  maintenanceMargin: string; availableMargin: string; maintenanceBuffer: string;
  marginRatioBps: string | null; effectiveLeverageBps: string | null; liquidatable: boolean;
  /** Every priced market; a market the API could not price is absent. */
  positions: Record<Market, AccountPosition>;
  /** Per-market margin multiplier and the leverage it allows. */
  marginParameters?: Record<Market, MarketMargin>;
};

export type OrderStatus = "open" | "executing" | "filled" | "cancelled" | "expired";
export type TriggerKind = "stop-loss" | "take-profit" | "stop-entry";
export type OrderType = "limit" | TriggerKind;
export type RestingOrder = {
  orderId: string; market: Market; side: Side; amount: string; baseDelta: string; limitPrice: string;
  maxFee: string; nonce: string; expiresAtMs: number; status: OrderStatus; transactionHash?: string; lastError?: string;
  /** Absent from older servers, where every order is a limit order. */
  type?: OrderType;
  /** Trigger fields are null on limit orders. Prices are USDC 1e6 strings. */
  triggerPrice?: string | null; triggerAbove?: boolean | null; slippageBps?: number | null;
  sizing?: "amount" | "position" | null;
  /** Shared by the two legs of a TP/SL pair; cancelling either cancels both. */
  pairId?: string | null;
  reduceOnly?: boolean;
};

export type Activity = {
  tx_hash: string; log_index: number; block_number: number; timestamp: number; kind: string;
  account: string; market: number | null; finality: "included" | "finalized";
  payload: { baseDelta?: string; price?: string; fee?: string; amount?: string };
};
export type ActivityPage = { items: Activity[]; nextCursor: string | null };

export type RiskMarket = { longBase: string; shortBase: string; netBase: string; longAccounts: number; shortAccounts: number };
export type Risk = { indexedBlock: number; accountCount: number; totalCollateral: string; markets: Record<Market, RiskMarket> };
export type PublicPosition = { account: string; collateral: string; positions: Record<Market, { size: string; entryPrice: string }> };
export type IndexerHealth = { ok: boolean; indexedBlock: number; finalizedBlock: number; headBlock: number; lag: number };
export type Protocol = { blockNumber: number; paused: boolean; resolutionRequired: boolean };

/** Margin parameters of one market, from `/v1/config` `markets` or `/v1/markets`. */
export type MarketMargin = { marginScaleBps: number; maxLeverage: number; initialMarginBps: number; maintenanceMarginBps: number };
export type MarginTier = { maxNotional: string | null; initialBps: number; maintenanceBps: number };

export type ChainConfig = {
  chainId: `0x${string}`; chainName: string; rpcUrl?: string;
  clearingAddress: `0x${string}`; tokenAddress?: `0x${string}`;
  /** Margin per market; null when the server's chain read was slow (fall back to `/v1/markets`). */
  markets?: Record<Market, MarketMargin> | null;
  /** Registered markets in contract index order (`marketMask` bit = index). */
  marketList?: Array<{ index: number; symbol: Market; enabled: boolean }>;
  marginTiers?: MarginTier[];
};

/** An EIP-712 payload prepared by the API for the user to sign. */
export type Prepared<I = Record<string, unknown>> = {
  domain: { name: string; version: string; chainId: string; verifyingContract: `0x${string}` };
  types: Record<string, Array<{ name: string; type: string }>>;
  intent: I;
};

export type Transaction = { hash: `0x${string}`; blockNumber: number };

/** POST /v1/orders/trigger/prepare, and each leg of POST /v1/orders/tpsl/prepare. */
export type PreparedTrigger = Prepared & {
  orderId: string; type: TriggerKind;
  trigger: { triggerPrice: string; triggerAbove: boolean };
  summary: {
    market: Market; side: Side; type: TriggerKind; amount: string; sizing: "amount" | "position";
    baseDelta: string; triggerPrice: string; triggerAbove: boolean; limitPrice: string;
    slippageBps: number; maxFee: string; reduceOnly: boolean; pairId: string | null; expiresAtMs: number;
  };
};
/** Legs are take-profit then stop-loss, each present only when its price was given. */
export type PreparedTpsl = { pairId: string; nonce: string; orders: PreparedTrigger[] };
export type CancelResult = { orderId: string; status: OrderStatus; cancelledOrderIds: string[]; transaction?: Transaction };

// Indexer portfolio read model (services/indexer/src/portfolio.ts).
export type Finality = "finalized" | "included";
export type Portfolio = {
  account: string; finality: Finality; indexedBlock: number; finalizedBlock: number;
  realizedPnl: string; fees: string; funding: string; liquidationPenalties: string; deficitCovered: string;
  netPnl: string; deposits: string; withdrawals: string; netDeposits: string; collateral: string;
  indexedCollateral: string | null; volume: string; tradeCount: number; fundingCount: number;
  positions: Record<Market, { size: string; entryPrice: string }>;
  firstEventMs: number | null; lastEventMs: number | null; incomplete: boolean;
};
export type PortfolioInterval = "event" | "1h" | "1d";
export type PortfolioPoint = {
  timeMs: number; blockNumber: number; realizedPnl: string; fees: string; funding: string;
  liquidationPenalties: string; netPnl: string; netDeposits: string; collateral: string;
};
export type PortfolioHistory = { account: string; interval: PortfolioInterval; finality: Finality; indexedBlock: number; truncated: boolean; points: PortfolioPoint[] };
export type Fill = {
  txHash: string; logIndex: number; blockNumber: number; timeMs: number; kind: "trade" | "close" | "liquidation";
  market: Market; baseDelta: string; price: string; fee: string; notional: string; sizeBefore: string; sizeAfter: string;
  entryPriceBefore: string; entryPriceAfter: string; realizedPnl: string; cumulativeRealizedPnl: string; finality: Finality;
};
export type FundingPayment = {
  txHash: string; logIndex: number; blockNumber: number; timeMs: number; market: Market;
  /** Positive means the account paid. */
  payment: string;
  /** Effect on the account's PnL (= -payment). */
  amount: string; cumulativeFunding: string; finality: Finality;
};
export type FillPage = { items: Fill[]; nextCursor: string | null; realizedPnl: string; indexedBlock: number };
export type FundingPage = { items: FundingPayment[]; nextCursor: string | null; totalFunding: string; indexedBlock: number };

// Market gateway candles (services/gateway/src/candles.ts). Prices are USDC 1e6 strings of the mid.
export type CandleInterval = "1m" | "5m" | "15m" | "1h" | "4h" | "1d";
export type Candle = { time: number; open: string; high: string; low: string; close: string; samples: number };
export type CandleSeries = { market: Market; interval: CandleInterval; unit: "usdc-micro"; source: string; candles: Candle[] };

/** The symbol at a contract index; pass the live list from `useMarketList()` for markets added after launch. */
export const marketFromIndex = (index: number | null | undefined, symbols: readonly Market[] = MARKETS): Market | null =>
  index === null || index === undefined ? null : symbols[index] ?? null;
