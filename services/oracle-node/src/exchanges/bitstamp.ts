import { parseDecimal } from "../decimal.js";
import { parseJson, quote, type ExchangeAdapter, type QuoteUpdate } from "./types.js";

const CHANNEL_PREFIX = "order_book_";

/** Bitstamp `order_book_<pair>` channel: top-100 snapshots pushed on every book change. */
export const bitstamp: ExchangeAdapter = {
  name: "bitstamp",
  bboComplete: true,
  websocketUrl: () => "wss://ws.bitstamp.net",
  pingMessage: JSON.stringify({ event: "bts:heartbeat" }),
  subscribeMessages: (tickers) =>
    tickers.map((ticker) =>
      JSON.stringify({ event: "bts:subscribe", data: { channel: `${CHANNEL_PREFIX}${ticker}` } }),
    ),
  createParser: () => (raw) => {
    const message = parseJson(raw);
    if (message?.event !== "data" || typeof message.channel !== "string") return [];
    if (!message.channel.startsWith(CHANNEL_PREFIX)) return [];
    const bid = message.data?.bids?.[0]?.[0],
      ask = message.data?.asks?.[0]?.[0];
    if (!bid || !ask) return [];
    return quote(message.channel.slice(CHANNEL_PREFIX.length), parseDecimal(bid), parseDecimal(ask));
  },
  restRequests: (tickers) =>
    tickers.length
      ? [
          {
            url: "https://www.bitstamp.net/api/v2/ticker/",
            tickers,
            parse: (body: any) => {
              const wanted = new Set(tickers),
                updates: QuoteUpdate[] = [];
              for (const row of Array.isArray(body) ? body : []) {
                const ticker = typeof row?.pair === "string" ? row.pair.replace("/", "").toLowerCase() : "";
                if (wanted.has(ticker) && row.bid && row.ask)
                  updates.push(...quote(ticker, parseDecimal(row.bid), parseDecimal(row.ask)));
              }
              return updates;
            },
          },
        ]
      : [],
};
