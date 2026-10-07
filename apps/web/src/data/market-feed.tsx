// The live market stream, shared by every page through context so the app
// holds one connection. Markets are whatever the stream carries (governance can
// add one at any time). Charts read candles (data/candles.ts), not this feed.
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { MARKET_STREAM } from "../lib/env.js";
import { useEventStream, type StreamStatus } from "../lib/event-stream.js";
import { priceStatus, type PriceStatus } from "../lib/market-stats.js";
import type { Market, MarketSnapshot } from "../lib/types.js";

/** The last mid each market had, kept when a market drops out of the stream. */
type LastPrice = { mid: string; observedAtMs: number };
type MarketFeed = {
  snapshot: MarketSnapshot | null;
  status: StreamStatus;
  /** When this client received the current snapshot (its own clock). */
  receivedAtMs: number | null;
  lastPrices: Record<Market, LastPrice>;
};

const MarketFeedContext = createContext<MarketFeed>({ snapshot: null, status: "connecting", receivedAtMs: null, lastPrices: {} });

export function MarketFeedProvider({ children }: { children: ReactNode }) {
  const [snapshot, setSnapshot] = useState<MarketSnapshot | null>(null);
  const [receivedAtMs, setReceivedAtMs] = useState<number | null>(null);
  const [lastPrices, setLastPrices] = useState<Record<Market, LastPrice>>({});
  const [streamError, setStreamError] = useState(false);

  const status = useEventStream(`${MARKET_STREAM}/v1/markets/stream`, {
    markets: data => {
      const next = data as MarketSnapshot;
      if (!next?.markets || typeof next.markets !== "object" || !Object.keys(next.markets).length) return;
      setSnapshot(next); setReceivedAtMs(Date.now()); setStreamError(false);
      setLastPrices(current => {
        const updated = { ...current };
        for (const [market, state] of Object.entries(next.markets)) updated[market] = { mid: state.mid, observedAtMs: state.observedAtMs };
        return updated;
      });
    },
    "stream-error": () => setStreamError(true),
  });

  return <MarketFeedContext.Provider value={{ snapshot, status: streamError ? "reconnecting" : status, receivedAtMs, lastPrices }}>{children}</MarketFeedContext.Provider>;
}

export const useMarketFeed = () => useContext(MarketFeedContext);

/** Re-renders on an interval; used to age quotes and detect stale prices. */
export function useNow(intervalMs = 500) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), intervalMs); return () => clearInterval(timer); }, [intervalMs]);
  return now;
}

/** One market's live state and whether its price is live, delayed, paused or unavailable. */
export function useMarketPrice(market: Market): { live: MarketSnapshot["markets"][Market] | undefined; status: PriceStatus; last: LastPrice | undefined } {
  const { snapshot, status, receivedAtMs, lastPrices } = useMarketFeed();
  const now = useNow(2_000);
  const live = snapshot?.markets[market];
  return {
    live,
    last: lastPrices[market],
    status: priceStatus(live, { streamLive: status === "live", nowMs: now, receivedAtMs, serverTimeMs: snapshot?.serverTimeMs }),
  };
}
