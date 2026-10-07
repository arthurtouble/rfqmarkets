import { parseDecimal } from "../decimal.js";
import { chunk, parseJson, quote, type ExchangeAdapter, type QuoteUpdate } from "./types.js";

/** OKX public `bbo-tbt` channel (tick-by-tick best bid/offer). Port 443; :8443 is often filtered. */
export const okx: ExchangeAdapter = {
  name: "okx",
  bboComplete: true,
  websocketUrl: () => "wss://ws.okx.com/ws/v5/public",
  pingMessage: "ping",
  subscribeMessages: (tickers) =>
    chunk(tickers, 50).map((batch) =>
      JSON.stringify({ op: "subscribe", args: batch.map((instId) => ({ channel: "bbo-tbt", instId })) }),
    ),
  createParser: () => (raw) => {
    const message = parseJson(raw);
    if (message?.arg?.channel !== "bbo-tbt" || typeof message.arg.instId !== "string") return [];
    const updates: QuoteUpdate[] = [];
    for (const item of Array.isArray(message.data) ? message.data : []) {
      const bid = item?.bids?.[0]?.[0],
        ask = item?.asks?.[0]?.[0];
      // An empty side clears the stored quote (quote() returns a cleared marker for a 0 side).
      updates.push(...quote(message.arg.instId, bid ? parseDecimal(bid) : 0n, ask ? parseDecimal(ask) : 0n));
    }
    return updates;
  },
  restRequests: (tickers) =>
    tickers.length
      ? [
          {
            url: "https://www.okx.com/api/v5/market/tickers?instType=SPOT",
            tickers,
            parse: (body: any) => {
              const wanted = new Set(tickers),
                updates: QuoteUpdate[] = [];
              for (const row of Array.isArray(body?.data) ? body.data : [])
                if (wanted.has(row?.instId) && row.bidPx && row.askPx)
                  updates.push(...quote(row.instId, parseDecimal(row.bidPx), parseDecimal(row.askPx)));
              return updates;
            },
          },
        ]
      : [],
};
