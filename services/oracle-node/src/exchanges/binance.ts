import { parseDecimal } from "../decimal.js";
import { parseJson, quote, type ExchangeAdapter, type QuoteUpdate } from "./types.js";

/**
 * Binance spot `<symbol>@bookTicker` combined stream (pushes every best bid/ask change). Uses the
 * market-data-only hosts on port 443, which are reachable from more networks than :9443.
 */
export const binance: ExchangeAdapter = {
  name: "binance",
  bboComplete: true,
  websocketUrl: (tickers) =>
    `wss://data-stream.binance.vision/stream?streams=${tickers.map((ticker) => `${ticker.toLowerCase()}@bookTicker`).join("/")}`,
  subscribeMessages: () => [],
  createParser: () => (raw) => {
    const message = parseJson(raw),
      data = message?.data ?? message;
    if (typeof data?.s !== "string" || data.b === undefined || data.a === undefined) return [];
    return quote(data.s, parseDecimal(data.b), parseDecimal(data.a));
  },
  restRequests: (tickers) =>
    tickers.length
      ? [
          {
            // The unfiltered list: a `symbols=` filter fails the whole request on one unknown symbol.
            url: "https://data-api.binance.vision/api/v3/ticker/bookTicker",
            tickers,
            parse: (body: any) => {
              const wanted = new Set(tickers),
                updates: QuoteUpdate[] = [];
              for (const row of Array.isArray(body) ? body : [])
                if (wanted.has(row?.symbol) && row.bidPrice && row.askPrice)
                  updates.push(...quote(row.symbol, parseDecimal(row.bidPrice), parseDecimal(row.askPrice)));
              return updates;
            },
          },
        ]
      : [],
};
