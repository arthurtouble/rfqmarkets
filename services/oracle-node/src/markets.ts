import { SYMBOLS } from "./symbols.js";

export interface OracleMarketDefinition {
  /** On-chain market id (uint8). */
  id: number;
  symbol: string;
}

/**
 * Where the node learns which markets to price. Static configuration for now; a later
 * implementation can read the clearing contract's market registry.
 */
export interface MarketSource {
  markets(): Promise<OracleMarketDefinition[]>;
}

export const DEFAULT_MARKETS: OracleMarketDefinition[] = [
  { id: 0, symbol: "BTC" },
  { id: 1, symbol: "ETH" },
];

export function validateMarkets(markets: readonly OracleMarketDefinition[], known = SYMBOLS) {
  const ids = new Set<number>(),
    symbols = new Set<string>();
  for (const market of markets) {
    if (!Number.isInteger(market.id) || market.id < 0 || market.id > 255)
      throw new Error(`invalid market id ${market.id}`);
    if (!known[market.symbol]) throw new Error(`unknown oracle symbol ${market.symbol}`);
    if (ids.has(market.id) || symbols.has(market.symbol))
      throw new Error(`duplicate market ${market.id}:${market.symbol}`);
    ids.add(market.id);
    symbols.add(market.symbol);
  }
  return [...markets].sort((a, b) => a.id - b.id);
}

/** Parses `[{"id":0,"symbol":"BTC"}]` or the short form `0:BTC,1:ETH`. */
export function parseMarkets(text: string | undefined): OracleMarketDefinition[] {
  if (!text?.trim()) return validateMarkets(DEFAULT_MARKETS);
  const trimmed = text.trim();
  const markets: OracleMarketDefinition[] = trimmed.startsWith("[")
    ? (JSON.parse(trimmed) as Array<{ id: unknown; symbol: unknown }>).map((item) => ({
        id: Number(item.id),
        symbol: String(item.symbol),
      }))
    : trimmed.split(",").map((entry) => {
        const [id, symbol] = entry.split(":").map((part) => part.trim());
        if (!id || !symbol || !/^\d+$/.test(id)) throw new Error(`invalid market entry ${entry}`);
        return { id: Number(id), symbol };
      });
  return validateMarkets(markets);
}

export class StaticMarketSource implements MarketSource {
  private list: OracleMarketDefinition[];
  constructor(markets: readonly OracleMarketDefinition[] = DEFAULT_MARKETS) {
    this.list = validateMarkets(markets);
  }
  async markets() {
    return this.list.map((market) => ({ ...market }));
  }
}
