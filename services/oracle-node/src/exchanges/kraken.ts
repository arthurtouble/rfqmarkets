import { parseDecimal } from "../decimal.js";
import { chunk, parseJson, quote, type ExchangeAdapter, type QuoteUpdate } from "./types.js";

/** Kraken WebSocket v2 `ticker` channel with `event_trigger: "bbo"` (pushes every top-of-book change). */
export const kraken: ExchangeAdapter = {
  name: "kraken",
  bboComplete: true,
  websocketUrl: () => "wss://ws.kraken.com/v2",
  pingMessage: JSON.stringify({ method: "ping" }),
  subscribeMessages: (tickers) =>
    chunk(tickers, 50).map((symbol) =>
      JSON.stringify({
        method: "subscribe",
        params: { channel: "ticker", symbol, event_trigger: "bbo", snapshot: true },
      }),
    ),
  createParser: () => (raw) => {
    const message = parseJson(raw);
    if (message?.channel !== "ticker" || !Array.isArray(message.data)) return [];
    const updates: QuoteUpdate[] = [];
    for (const item of message.data)
      if (typeof item?.symbol === "string")
        updates.push(...quote(item.symbol, parseDecimal(item.bid), parseDecimal(item.ask)));
    return updates;
  },
  restRequests: (tickers) =>
    tickers.length
      ? [
          {
            // Pairs requested in "BASE/QUOTE" form come back under the same keys.
            url: `https://api.kraken.com/0/public/Ticker?pair=${tickers.map(encodeURIComponent).join(",")}`,
            tickers,
            parse: (body: any) => {
              const updates: QuoteUpdate[] = [];
              for (const ticker of tickers) {
                const row = body?.result?.[ticker];
                if (row?.b?.[0] && row?.a?.[0])
                  updates.push(...quote(ticker, parseDecimal(row.b[0]), parseDecimal(row.a[0])));
              }
              return updates;
            },
          },
        ]
      : [],
};
