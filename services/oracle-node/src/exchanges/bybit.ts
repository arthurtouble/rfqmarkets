import { parseDecimal } from "../decimal.js";
import { chunk, parseJson, quote, type ExchangeAdapter, type QuoteUpdate } from "./types.js";

const TOPIC_PREFIX = "orderbook.1.";

/**
 * Bybit v5 spot `orderbook.1.<symbol>`: level-1 snapshots pushed on change (and re-pushed after
 * 3 s without one). A delta may carry one side only, so the parser keeps the last book per symbol.
 */
export const bybit: ExchangeAdapter = {
  name: "bybit",
  bboComplete: true,
  websocketUrl: () => "wss://stream.bybit.com/v5/public/spot",
  pingMessage: JSON.stringify({ op: "ping" }),
  subscribeMessages: (tickers) =>
    // Spot accepts at most 10 topics per subscribe request.
    chunk(tickers, 10).map((batch) =>
      JSON.stringify({ op: "subscribe", args: batch.map((ticker) => `${TOPIC_PREFIX}${ticker}`) }),
    ),
  createParser: () => {
    const books = new Map<string, { bid?: bigint; ask?: bigint }>();
    const level = (entry: unknown) => {
      if (!Array.isArray(entry)) return undefined;
      return Number(entry[1]) === 0 ? null : parseDecimal(entry[0]);
    };
    return (raw) => {
      const message = parseJson(raw);
      if (typeof message?.topic !== "string" || !message.topic.startsWith(TOPIC_PREFIX)) return [];
      const ticker: string = message.data?.s ?? message.topic.slice(TOPIC_PREFIX.length);
      const book = message.type === "snapshot" ? {} : { ...books.get(ticker) };
      const bid = level(message.data?.b?.[0]),
        ask = level(message.data?.a?.[0]);
      if (bid !== undefined) book.bid = bid ?? undefined;
      if (ask !== undefined) book.ask = ask ?? undefined;
      books.set(ticker, book);
      // A one-sided book clears the stored quote (quote() returns a cleared marker for a 0 side).
      return quote(ticker, book.bid ?? 0n, book.ask ?? 0n);
    };
  },
  restRequests: (tickers) =>
    tickers.length
      ? [
          {
            url: "https://api.bybit.com/v5/market/tickers?category=spot",
            tickers,
            parse: (body: any) => {
              const wanted = new Set(tickers),
                updates: QuoteUpdate[] = [];
              for (const row of Array.isArray(body?.result?.list) ? body.result.list : [])
                if (wanted.has(row?.symbol) && row.bid1Price && row.ask1Price)
                  updates.push(
                    ...quote(row.symbol, parseDecimal(row.bid1Price), parseDecimal(row.ask1Price)),
                  );
              return updates;
            },
          },
        ]
      : [],
};
