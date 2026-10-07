import type { ExchangeName } from "../symbols.js";

/** A venue's best bid/ask for one ticker, as 18-decimal prices in the ticker's quote currency. */
export interface QuoteUpdate {
  ticker: string;
  bid: bigint;
  ask: bigint;
}

export interface RestRequest {
  url: string;
  /** The tickers this request can refresh. */
  tickers: readonly string[];
  parse(body: unknown): QuoteUpdate[];
}

/** Parses one raw websocket message; returns no updates for control or unrelated messages. */
export type MessageParser = (raw: string) => QuoteUpdate[];

/**
 * A venue adapter: pure message formats only, no I/O, so each one is testable from fixtures.
 * ExchangeFeed owns the connection, reconnects, pings and the REST fallback.
 */
export interface ExchangeAdapter {
  readonly name: ExchangeName;
  /**
   * True when the stream pushes every top-of-book change, so silence on a live connection means the
   * book is unchanged and a quote received on it stays current while the connection keeps talking.
   */
  readonly bboComplete: boolean;
  websocketUrl(tickers: readonly string[]): string;
  subscribeMessages(tickers: readonly string[]): string[];
  /** Application-level ping, sent periodically so a quiet connection still proves it is alive. */
  readonly pingMessage?: string;
  /** A fresh parser per connection (some venues need book state). */
  createParser(): MessageParser;
  restRequests(tickers: readonly string[]): RestRequest[];
}

export function quote(ticker: string, bid: bigint, ask: bigint): QuoteUpdate[] {
  return bid > 0n && ask >= bid ? [{ ticker, bid, ask }] : [];
}

/** Splits tickers into subscription batches (venues rate-limit subscribe messages). */
export function chunk<T>(items: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) chunks.push(items.slice(index, index + size));
  return chunks;
}

export function parseJson(raw: string): any {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}
