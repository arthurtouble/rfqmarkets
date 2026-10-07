/**
 * Static symbol table: maps a market symbol to the exchange tickers that price it.
 *
 * Tickers are derived by each exchange's convention from the base asset; `exclude` lists venues
 * without a liquid pair (checked against each venue's public instrument list and live
 * subscriptions, 2026-10), and
 * `tickers` overrides a derived ticker. A lot multiplier prices a bundle of base units, e.g.
 * kPEPE = 1000 PEPE.
 */

export const EXCHANGES = ["coinbase", "kraken", "bitstamp", "gemini", "okx", "bybit", "binance"] as const;
export type ExchangeName = (typeof EXCHANGES)[number];
export type QuoteCurrency = "USD" | "USDT" | "USDC";

export interface SymbolSpec {
  /** Base asset traded on the venues. */
  base: string;
  /** Base units per market unit. */
  multiplier?: bigint;
  exclude?: readonly ExchangeName[];
  tickers?: Partial<Record<ExchangeName, { ticker: string; quote: QuoteCurrency }>>;
}

export interface Instrument {
  exchange: ExchangeName;
  ticker: string;
  quote: QuoteCurrency;
}
export interface SymbolInstruments {
  symbol: string;
  multiplier: bigint;
  instruments: Instrument[];
}

/** Each venue's default quote currency and ticker convention. */
const CONVENTIONS: Record<ExchangeName, { quote: QuoteCurrency; ticker: (base: string) => string }> = {
  coinbase: { quote: "USD", ticker: (base) => `${base}-USD` },
  kraken: { quote: "USD", ticker: (base) => `${base}/USD` },
  bitstamp: { quote: "USD", ticker: (base) => `${base.toLowerCase()}usd` },
  gemini: { quote: "USD", ticker: (base) => `${base}USD` },
  okx: { quote: "USDT", ticker: (base) => `${base}-USDT` },
  bybit: { quote: "USDT", ticker: (base) => `${base}USDT` },
  binance: { quote: "USDT", ticker: (base) => `${base}USDT` },
};

/** Roughly the top 30 non-stablecoin assets by market capitalisation. */
export const SYMBOLS: Record<string, SymbolSpec> = {
  BTC: { base: "BTC" },
  ETH: { base: "ETH" },
  XRP: { base: "XRP" },
  BNB: { base: "BNB" },
  SOL: { base: "SOL" },
  TRX: { base: "TRX", exclude: ["coinbase"] },
  DOGE: { base: "DOGE" },
  ADA: { base: "ADA", exclude: ["gemini"] },
  HYPE: { base: "HYPE" },
  LINK: { base: "LINK" },
  BCH: { base: "BCH" },
  XLM: { base: "XLM", exclude: ["gemini"] },
  SUI: { base: "SUI" },
  AVAX: { base: "AVAX" },
  LTC: { base: "LTC" },
  HBAR: { base: "HBAR", exclude: ["gemini"] },
  TON: { base: "TON", exclude: ["gemini", "okx", "bybit", "binance"] },
  kSHIB: { base: "SHIB", multiplier: 1_000n },
  DOT: { base: "DOT" },
  UNI: { base: "UNI" },
  kPEPE: { base: "PEPE", multiplier: 1_000n },
  AAVE: { base: "AAVE" },
  NEAR: { base: "NEAR", exclude: ["gemini"] },
  APT: { base: "APT", exclude: ["bitstamp", "gemini"] },
  ICP: { base: "ICP", exclude: ["gemini"] },
  ETC: { base: "ETC", exclude: ["gemini"] },
  ONDO: { base: "ONDO", exclude: ["gemini"] },
  POL: { base: "POL" },
  ARB: { base: "ARB" },
  ATOM: { base: "ATOM" },
  ENA: { base: "ENA", exclude: ["gemini"] },
  WLD: { base: "WLD" },
  kBONK: { base: "BONK", multiplier: 1_000n },
  TAO: { base: "TAO", exclude: ["gemini", "bybit"] },
};

/** Stablecoin/USD pairs used to convert USDT- and USDC-quoted venues to USD. */
export const STABLE_INSTRUMENTS: Record<"USDT" | "USDC", Instrument[]> = {
  USDT: [
    { exchange: "kraken", ticker: "USDT/USD", quote: "USD" },
    { exchange: "coinbase", ticker: "USDT-USD", quote: "USD" },
    { exchange: "bitstamp", ticker: "usdtusd", quote: "USD" },
    { exchange: "gemini", ticker: "USDTUSD", quote: "USD" },
  ],
  USDC: [
    { exchange: "kraken", ticker: "USDC/USD", quote: "USD" },
    { exchange: "bitstamp", ticker: "usdcusd", quote: "USD" },
  ],
};

export function resolveSymbol(
  symbol: string,
  table: Record<string, SymbolSpec> = SYMBOLS,
  exchanges: readonly ExchangeName[] = EXCHANGES,
): SymbolInstruments {
  const spec = table[symbol];
  if (!spec) throw new Error(`unknown oracle symbol ${symbol}`);
  const multiplier = spec.multiplier ?? 1n;
  if (multiplier <= 0n) throw new Error(`invalid multiplier for ${symbol}`);
  const instruments: Instrument[] = [];
  for (const exchange of exchanges) {
    if (spec.exclude?.includes(exchange)) continue;
    const override = spec.tickers?.[exchange],
      convention = CONVENTIONS[exchange];
    instruments.push(
      override
        ? { exchange, ...override }
        : { exchange, ticker: convention.ticker(spec.base), quote: convention.quote },
    );
  }
  return { symbol, multiplier, instruments };
}
