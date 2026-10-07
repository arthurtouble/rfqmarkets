/** Market names in on-chain index order. */
export const MARKETS = ["BTC", "ETH"] as const;
export type Market = (typeof MARKETS)[number];
export type MarketIndex = 0 | 1;

export const marketIndex = (market: Market): MarketIndex => (market === "BTC" ? 0 : 1);

export function marketName(index: number | bigint): Market {
  const value = Number(index);
  if (value !== 0 && value !== 1) throw new Error(`unknown market index ${index}`);
  return MARKETS[value];
}

export const otherMarketIndex = (index: MarketIndex): MarketIndex => (index === 0 ? 1 : 0);
