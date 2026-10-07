import { parseDecimal } from "../decimal.js";
import { chunk, parseJson, quote, type ExchangeAdapter, type QuoteUpdate } from "./types.js";

class BookSide {
  private levels = new Map<bigint, bigint>();
  private best?: bigint;
  private dirty = false;
  constructor(private higherIsBetter: boolean) {}
  private better(a: bigint, b: bigint) {
    return this.higherIsBetter ? a > b : a < b;
  }
  set(price: bigint, size: bigint) {
    if (size === 0n) {
      this.levels.delete(price);
      if (price === this.best) this.dirty = true;
      return;
    }
    this.levels.set(price, size);
    if (!this.dirty && (this.best === undefined || this.better(price, this.best))) this.best = price;
  }
  top() {
    if (this.dirty) {
      this.best = undefined;
      for (const price of this.levels.keys())
        if (this.best === undefined || this.better(price, this.best)) this.best = price;
      this.dirty = false;
    }
    return this.best;
  }
}

/**
 * Gemini market data v2 `l2` subscription. The first message per symbol carries the full book
 * (it includes a `trades` array); later `l2_updates` carry level changes. One connection covers
 * every symbol, so a quiet book stays current while the connection keeps talking.
 */
export const gemini: ExchangeAdapter = {
  name: "gemini",
  bboComplete: true,
  websocketUrl: () => "wss://api.gemini.com/v2/marketdata",
  subscribeMessages: (tickers) =>
    chunk(tickers, 50).map((symbols) =>
      JSON.stringify({ type: "subscribe", subscriptions: [{ name: "l2", symbols }] }),
    ),
  createParser: () => {
    const books = new Map<string, { bids: BookSide; asks: BookSide }>();
    return (raw) => {
      const message = parseJson(raw);
      if (
        message?.type !== "l2_updates" ||
        typeof message.symbol !== "string" ||
        !Array.isArray(message.changes)
      )
        return [];
      let book = books.get(message.symbol);
      if (!book || Array.isArray(message.trades)) {
        book = { bids: new BookSide(true), asks: new BookSide(false) };
        books.set(message.symbol, book);
      }
      for (const change of message.changes) {
        if (!Array.isArray(change) || change.length < 3) continue;
        const [side, price, size] = change;
        (side === "buy" ? book.bids : side === "sell" ? book.asks : undefined)?.set(
          parseDecimal(price),
          parseDecimal(size),
        );
      }
      const bid = book.bids.top(),
        ask = book.asks.top();
      // A one-sided book clears the stored quote (quote() returns a cleared marker for a 0 side).
      return quote(message.symbol, bid ?? 0n, ask ?? 0n);
    };
  },
  restRequests: (tickers) =>
    tickers.map((ticker) => ({
      url: `https://api.gemini.com/v1/pubticker/${ticker.toLowerCase()}`,
      tickers: [ticker],
      parse: (body: any): QuoteUpdate[] => quote(ticker, parseDecimal(body?.bid), parseDecimal(body?.ask)),
    })),
};
