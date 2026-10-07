import { parseDecimal } from "../decimal.js";
import { chunk, parseJson, quote, type ExchangeAdapter, type QuoteUpdate } from "./types.js";

/**
 * Coinbase Advanced Trade `ticker` channel. It is trade-driven (best bid/ask ride on match
 * updates), so quotes age by their own receive time and quiet books fall back to REST.
 */
export const coinbase: ExchangeAdapter = {
  name: "coinbase",
  bboComplete: false,
  websocketUrl: () => "wss://advanced-trade-ws.coinbase.com",
  subscribeMessages: (tickers) => [
    // Unauthenticated connections may send only a few messages per second, so batch products.
    ...chunk(tickers, 25).map((product_ids) =>
      JSON.stringify({ type: "subscribe", product_ids, channel: "ticker" }),
    ),
    JSON.stringify({ type: "subscribe", channel: "heartbeats" }),
  ],
  createParser: () => (raw) => {
    const message = parseJson(raw);
    if (message?.channel !== "ticker" || !Array.isArray(message.events)) return [];
    const updates: QuoteUpdate[] = [];
    for (const event of message.events)
      for (const ticker of event?.tickers ?? [])
        if (typeof ticker?.product_id === "string" && ticker.best_bid && ticker.best_ask)
          updates.push(
            ...quote(ticker.product_id, parseDecimal(ticker.best_bid), parseDecimal(ticker.best_ask)),
          );
    return updates;
  },
  restRequests: (tickers) =>
    tickers.map((ticker) => ({
      url: `https://api.exchange.coinbase.com/products/${encodeURIComponent(ticker)}/ticker`,
      tickers: [ticker],
      parse: (body: any) => quote(ticker, parseDecimal(body?.bid), parseDecimal(body?.ask)),
    })),
};
