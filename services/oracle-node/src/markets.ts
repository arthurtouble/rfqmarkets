import { readMarketsFromChain, type MarketRegistryReader } from "../../../packages/shared/src/markets.js";
import { SYMBOLS, type SymbolSpec } from "./symbols.js";

export interface OracleMarketDefinition {
  /** On-chain market id (uint8). */
  id: number;
  symbol: string;
}

/**
 * Where the node learns which markets to price: `StaticMarketSource` (ORACLE_MARKETS) or
 * `ChainMarketSource` (the clearing contract's registry, so a market governance adds is priced
 * without a redeploy). The node re-reads the source every `marketRefreshMs`.
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
    if (!Number.isInteger(market.id) || market.id < 0 || market.id > 127)
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

export interface ChainMarketSourceOptions {
  /** Only these symbols are priced (ORACLE_MARKETS when set alongside the chain source). */
  allow?: readonly OracleMarketDefinition[];
  /** The node's symbol table; a registered market without an entry is skipped and logged. */
  known?: Record<string, SymbolSpec>;
  /** Used when the first chain read fails, so a node can start while its RPC is down. */
  fallback?: readonly OracleMarketDefinition[];
  log?: (message: string) => void;
}

/**
 * Prices every market the clearing contract registers (`marketCount`, `marketParams(i).symbol`)
 * that this node's symbol table knows. Disabled markets are still priced: reductions and
 * liquidations need a fresh price. A failed read throws, so the node keeps its previous list.
 */
export class ChainMarketSource implements MarketSource {
  private loaded = false;
  private readonly skipped = new Set<string>();
  constructor(
    private readonly reader: MarketRegistryReader,
    private readonly options: ChainMarketSourceOptions = {},
  ) {}
  async markets() {
    const known = this.options.known ?? SYMBOLS,
      allow = this.options.allow;
    let registered;
    try {
      registered = await readMarketsFromChain(this.reader);
    } catch (error) {
      if (!this.loaded && this.options.fallback) {
        this.options.log?.(
          `market registry unavailable, pricing the configured markets: ${(error as Error).message}`,
        );
        return validateMarkets(this.options.fallback, known);
      }
      throw error;
    }
    this.loaded = true;
    const markets: OracleMarketDefinition[] = [];
    for (const { index, symbol } of registered) {
      if (allow) {
        const allowed = allow.find((market) => market.symbol === symbol);
        if (!allowed) continue;
        if (allowed.id !== index) {
          this.skip(
            `${index}:${symbol}`,
            `ORACLE_MARKETS lists ${symbol} as market ${allowed.id}, the chain as ${index}`,
          );
          continue;
        }
      }
      if (!Object.hasOwn(known, symbol)) {
        this.skip(
          `${index}:${symbol}`,
          `no oracle symbol table entry for ${symbol} (services/oracle-node/src/symbols.ts)`,
        );
        continue;
      }
      markets.push({ id: index, symbol });
    }
    return validateMarkets(markets, known);
  }
  private skip(key: string, reason: string) {
    if (this.skipped.has(key)) return;
    this.skipped.add(key);
    this.options.log?.(`registered market ${key} is not priced by this node: ${reason}`);
  }
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
