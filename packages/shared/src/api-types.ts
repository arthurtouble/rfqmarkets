// Response types of the public HTTP surface: the API (services/api), market gateway and indexer. The web
// app, SDK and MCP server import them from here. Amounts are decimal strings: USDC values in 1e6 units,
// base sizes in 1e18. Signed structs live in eip712.ts.
import type { TriggerKind } from "./trigger.js";

export type { TriggerKind };

export type Side = "buy" | "sell";
/**
 * A market symbol. Markets are registered on chain by governance, so any
 * symbol the API lists is valid; the web app reads the live list with `useMarketList()`.
 */
export type Market = string;
export type RiskMode = "normal" | "guarded" | "reduce_only";

export type SpreadBreakdown = {
  baseBps: string;
  volatilityBps: string;
  toxicityBps: string;
  hedgeBps: string;
  basisBps: string;
  uncertaintyBps: string;
  totalBps: string;
  modelVersion: string;
};

export type Quote = {
  quoteId?: string;
  market?: Market;
  side?: Side;
  amount?: string;
  baseDelta?: string;
  expectedPrice: string;
  worstPrice: string;
  fee: string;
  impactCharge: string;
  spread?: SpreadBreakdown;
  expiresAtMs: number;
  bid: string;
  ask: string;
  observedAtMs: number;
};

export type MarketState = {
  market: Market;
  bid: string;
  ask: string;
  mid: string;
  observedAtMs: number;
  source: string;
  volatilityBps: number;
  baseSpreadBps: number;
  spread?: SpreadBreakdown;
  fundingApr: string;
  fundingIndex: string;
  projectedFundingIndex: string;
  enabled: boolean;
  maxTradeNotional: string;
  maxMarketNotional: string;
  operatingMaxTradeNotional: string;
  riskMode: RiskMode;
  canBuy: boolean;
  canSell: boolean;
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
  blockNumber: number;
  serverTimeMs: number;
  markets: Record<Market, MarketState>;
  pricing: {
    settled: Record<Market, string>;
    pending: Array<{ market: Market; delta: string }>;
    baseSpreadBps: number;
    feeBps: number;
    toleranceBps: number;
  };
};

export type AccountPosition = {
  size: string;
  entryPrice: string;
  markPrice: string;
  notional: string;
  unrealizedPnl: string;
  accruedFunding: string;
  lastFundingIndex: string;
  estimatedLiquidationPrice: string | null;
  initialMargin?: string;
  maintenanceMargin?: string;
};

export type AccountState = {
  account: string;
  blockNumber: number;
  collateral: string;
  equity: string;
  openingEquity: string;
  unrealizedPnl: string;
  accruedFunding: string;
  grossNotional: string;
  initialMargin: string;
  maintenanceMargin: string;
  availableMargin: string;
  maintenanceBuffer: string;
  marginRatioBps: string | null;
  effectiveLeverageBps: string | null;
  liquidatable: boolean;
  /** Every priced market; a market the API could not price is absent. */
  positions: Record<Market, AccountPosition>;
  /** Per-market margin multiplier and the leverage it allows. */
  marginParameters?: Record<Market, MarketMargin>;
};

export type OrderStatus = "open" | "executing" | "filled" | "cancelled" | "expired";
export type OrderType = "limit" | TriggerKind;
export type RestingOrder = {
  orderId: string;
  market: Market;
  side: Side;
  amount: string;
  baseDelta: string;
  limitPrice: string;
  maxFee: string;
  nonce: string;
  expiresAtMs: number;
  status: OrderStatus;
  transactionHash?: string;
  lastError?: string;
  /** Absent from older servers, where every order is a limit order. */
  type?: OrderType;
  /** Trigger fields are null on limit orders. Prices are USDC 1e6 strings. */
  triggerPrice?: string | null;
  triggerAbove?: boolean | null;
  slippageBps?: number | null;
  sizing?: "amount" | "position" | null;
  /** Shared by the two legs of a TP/SL pair; cancelling either cancels both. */
  pairId?: string | null;
  reduceOnly?: boolean;
};

export type Activity = {
  tx_hash: string;
  log_index: number;
  block_number: number;
  timestamp: number;
  kind: string;
  account: string;
  market: number | null;
  finality: "included" | "finalized";
  payload: { baseDelta?: string; price?: string; fee?: string; amount?: string };
};
export type ActivityPage = { items: Activity[]; nextCursor: string | null };

export type RiskMarket = {
  longBase: string;
  shortBase: string;
  netBase: string;
  longAccounts: number;
  shortAccounts: number;
};
export type Risk = {
  indexedBlock: number;
  accountCount: number;
  totalCollateral: string;
  markets: Record<Market, RiskMarket>;
};
export type PublicPosition = {
  account: string;
  collateral: string;
  positions: Record<Market, { size: string; entryPrice: string }>;
};
export type IndexerHealth = {
  ok: boolean;
  indexedBlock: number;
  finalizedBlock: number;
  headBlock: number;
  lag: number;
};
export type Protocol = { blockNumber: number; paused: boolean; resolutionRequired: boolean };

/** Margin parameters of one market, from `/v1/config` `markets` or `/v1/markets`. */
export type MarketMargin = {
  marginScaleBps: number;
  maxLeverage: number;
  initialMarginBps: number;
  maintenanceMarginBps: number;
};
export type MarginTier = { maxNotional: string | null; initialBps: number; maintenanceBps: number };

export type ChainConfig = {
  chainId: `0x${string}`;
  chainName: string;
  rpcUrl?: string;
  clearingAddress: `0x${string}`;
  tokenAddress?: `0x${string}`;
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
  orderId: string;
  type: TriggerKind;
  trigger: { triggerPrice: string; triggerAbove: boolean };
  summary: {
    market: Market;
    side: Side;
    type: TriggerKind;
    amount: string;
    sizing: "amount" | "position";
    baseDelta: string;
    triggerPrice: string;
    triggerAbove: boolean;
    limitPrice: string;
    slippageBps: number;
    maxFee: string;
    reduceOnly: boolean;
    pairId: string | null;
    expiresAtMs: number;
  };
};
/** Legs are take-profit then stop-loss, each present only when its price was given. */
export type PreparedTpsl = { pairId: string; nonce: string; orders: PreparedTrigger[] };
export type CancelResult = {
  orderId: string;
  status: OrderStatus;
  cancelledOrderIds: string[];
  transaction?: Transaction;
};

/** GET /v1/quote/ladder: indicative prices at several sizes. Prices and charges are USDC 1e6 strings. */
export type LadderRung = {
  amount: string;
  /** Average execution price, USDC micro-units per base unit. */
  price: string;
  /** Execution price vs the oracle mid, in bps (always a cost: positive for buys and sells). */
  costBps: string;
  impactCharge: string;
  fee: string;
};
export type QuoteLadder = { market: Market; mid: string | null; buy: LadderRung[]; sell: LadderRung[] };

/** POST /v1/approve: the signed trade, its approver quorum and the settlement transaction. */
export type TradeResult = Prepared & {
  trigger?: Record<string, unknown>;
  userSignature: string;
  approval: Record<string, unknown>;
  approvals: Array<{ digest: string; signer: string; signature: string }>;
  quote: Quote;
  transaction: Transaction;
};
/** POST /v1/orders: a signed order the API now holds until it fills, expires or is cancelled. */
export type PlacedOrder = {
  orderId: string;
  type: OrderType;
  status: OrderStatus;
  intent: Record<string, unknown>;
  trigger?: Record<string, unknown>;
};
/** POST /v1/withdraw/execute and /v1/isolated/margin/execute. */
export type ActionResult = { status: "included"; transaction: Transaction; collateral?: string };
/** POST /v1/session/execute. */
export type SessionGrantResult = {
  status: "active";
  session: string;
  validUntil: string;
  transaction: Transaction;
};

// Indexer portfolio read model (services/indexer/src/portfolio.ts).
export type Finality = "finalized" | "included";
export type Portfolio = {
  account: string;
  /** With isolated accounts included: the owner first, then each isolated account it has moved margin into. */
  accounts?: string[];
  finality: Finality;
  indexedBlock: number;
  finalizedBlock: number;
  realizedPnl: string;
  fees: string;
  funding: string;
  liquidationPenalties: string;
  deficitCovered: string;
  netPnl: string;
  deposits: string;
  withdrawals: string;
  netDeposits: string;
  collateral: string;
  indexedCollateral: string | null;
  volume: string;
  tradeCount: number;
  fundingCount: number;
  positions: Record<Market, { size: string; entryPrice: string }>;
  firstEventMs: number | null;
  lastEventMs: number | null;
  incomplete: boolean;
};
export type PortfolioInterval = "event" | "1h" | "1d";
export type PortfolioPoint = {
  timeMs: number;
  blockNumber: number;
  realizedPnl: string;
  fees: string;
  funding: string;
  liquidationPenalties: string;
  netPnl: string;
  netDeposits: string;
  collateral: string;
};
export type PortfolioHistory = {
  account: string;
  interval: PortfolioInterval;
  finality: Finality;
  indexedBlock: number;
  truncated: boolean;
  points: PortfolioPoint[];
};
export type Fill = {
  txHash: string;
  logIndex: number;
  blockNumber: number;
  timeMs: number;
  kind: "trade" | "close" | "liquidation";
  market: Market;
  baseDelta: string;
  price: string;
  fee: string;
  notional: string;
  sizeBefore: string;
  sizeAfter: string;
  entryPriceBefore: string;
  entryPriceAfter: string;
  realizedPnl: string;
  cumulativeRealizedPnl: string;
  finality: Finality;
  /** The account it happened on when the read includes isolated accounts (a Home trade's isolated account). */
  account?: string;
};
export type FundingPayment = {
  txHash: string;
  logIndex: number;
  blockNumber: number;
  timeMs: number;
  market: Market;
  /** Positive means the account paid. */
  payment: string;
  /** Effect on the account's PnL (= -payment). */
  amount: string;
  cumulativeFunding: string;
  finality: Finality;
};
export type FillPage = {
  items: Fill[];
  nextCursor: string | null;
  realizedPnl: string;
  indexedBlock: number;
};
export type FundingPage = {
  items: FundingPayment[];
  nextCursor: string | null;
  totalFunding: string;
  indexedBlock: number;
};

// Indexer leaderboard and points (services/indexer/src/leaderboard.ts). Isolated accounts count towards
// their owner; amounts are USDC 1e6 strings and points are whole numbers (1 per 100 USDC traded).
export type LeaderboardWindow = "1d" | "7d" | "30d" | "all";
export type LeaderboardSort = "volume" | "pnl";
export type LeaderboardEntry = {
  rank: number;
  account: string;
  volume: string;
  netPnl: string;
  tradeCount: number;
  points: string;
};
export type Leaderboard = {
  window: LeaderboardWindow;
  sort: LeaderboardSort;
  finality: Finality;
  indexedBlock: number;
  traders: LeaderboardEntry[];
};
export type PointsWeek = { weekStartMs: number; volume: string; points: string };
export type Points = {
  account: string;
  finality: Finality;
  indexedBlock: number;
  accounts: string[];
  total: string;
  weeks: PointsWeek[];
  referees: number;
  /** Referees whose points count toward `referralPoints` (the earliest ones, capped by the indexer). */
  countedReferees?: number;
  referralPoints: string;
  totalWithReferrals: string;
};

// Market gateway candles (services/gateway/src/candles.ts). Prices are USDC 1e6 strings of the mid.
export type CandleInterval = "1m" | "5m" | "15m" | "1h" | "4h" | "1d";
export type Candle = {
  time: number;
  open: string;
  high: string;
  low: string;
  close: string;
  samples: number;
};
export type CandleSeries = {
  market: Market;
  interval: CandleInterval;
  unit: "usdc-micro";
  source: string;
  candles: Candle[];
};
