export type Side = "buy" | "sell";
export type Market = "BTC" | "ETH";
export type Quote = { quoteId: string; expectedPrice: string; worstPrice: string; fee: string; expiresAtMs: number };
export type WalletProvider = { request(args: { method: string; params?: unknown[] }): Promise<unknown> };
export type AccountState = { collateral: string; positions: Record<Market, { size: string; entryPrice: string }> };
export type RiskMarket = { longBase: string; shortBase: string; netBase: string; longAccounts: number; shortAccounts: number };
export type Risk = { indexedBlock: number; accountCount: number; totalCollateral: string; markets: Record<Market, RiskMarket> };
export type Position = { account: string; collateral: string; positions: Record<Market, { size: string; entryPrice: string }> };
export type TradeActivity = {
  tx_hash: string; log_index: number; block_number: number; timestamp: number; kind: string; account: string; market: number;
  finality: "included" | "finalized"; payload: { baseDelta: string; price: string; fee: string };
};
