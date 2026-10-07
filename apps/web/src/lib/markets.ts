// The market list. Markets are registered on chain and can be added by
// governance at any time, so the list comes from GET /v1/config (marketList,
// markets) and the live market stream rather than a constant.
import { marginForScale } from "./leverage.js";
import { MARKETS, type ChainConfig, type Market, type MarketMargin, type MarketSnapshot } from "./types.js";

export type MarketInfo = MarketMargin & {
  symbol: Market;
  /** Contract index: the market's bit in a session `marketMask`. */
  index: number;
  /** A disabled market accepts only position reductions. */
  enabled: boolean;
  /** Whether the live stream currently prices this market. */
  priced: boolean;
};

/**
 * Merges the boot config and the latest snapshot into one list in contract
 * index order. Margin comes from the snapshot when it carries it (fresh per
 * block), then the config, then the 1x defaults.
 */
export function marketInfos(config: ChainConfig | null | undefined, snapshot: MarketSnapshot | null | undefined): MarketInfo[] {
  const order = new Map<Market, { index: number; enabled: boolean }>();
  for (const item of config?.marketList ?? []) order.set(item.symbol, { index: item.index, enabled: item.enabled });
  for (const live of Object.values(snapshot?.markets ?? {})) {
    if (order.has(live.market)) continue;
    order.set(live.market, { index: live.index ?? Number.MAX_SAFE_INTEGER, enabled: live.enabled });
  }
  if (!order.size) MARKETS.forEach((symbol, index) => order.set(symbol, { index, enabled: true }));
  return [...order.entries()]
    .map(([symbol, entry]) => {
      const live = snapshot?.markets[symbol];
      const margin: MarketMargin = live?.marginScaleBps !== undefined && live.maxLeverage !== undefined
        ? { marginScaleBps: live.marginScaleBps, maxLeverage: live.maxLeverage, initialMarginBps: live.initialMarginBps ?? marginForScale(live.marginScaleBps).initialMarginBps, maintenanceMarginBps: live.maintenanceMarginBps ?? marginForScale(live.marginScaleBps).maintenanceMarginBps }
        : config?.markets?.[symbol] ?? marginForScale(live?.marginScaleBps);
      return { symbol, index: live?.index ?? entry.index, enabled: live?.enabled ?? entry.enabled, priced: !!live, ...margin };
    })
    .sort((a, b) => a.index - b.index || a.symbol.localeCompare(b.symbol));
}

/** Symbols by contract index, for `marketFromIndex(index, symbols)`; gaps stay undefined. */
export function symbolsByIndex(markets: readonly MarketInfo[]): Market[] {
  const symbols: Market[] = [];
  for (const market of markets) if (market.index < Number.MAX_SAFE_INTEGER) symbols[market.index] = market.symbol;
  return symbols;
}
