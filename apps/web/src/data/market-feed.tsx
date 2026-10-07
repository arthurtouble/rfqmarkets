// The live market stream, shared by every page through context so the app
// holds one connection. History is seeded from the gateway, then extended.
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { MARKET_STREAM } from "../lib/env.js";
import { useEventStream, type StreamStatus } from "../lib/event-stream.js";
import { getJson } from "../lib/http.js";
import { MARKETS, type Market, type MarketSnapshot } from "../lib/types.js";

const HISTORY_POINTS = 240;
type History = Record<Market, number[]>;
type MarketFeed = { snapshot: MarketSnapshot | null; status: StreamStatus; history: History };

const MarketFeedContext = createContext<MarketFeed>({ snapshot: null, status: "connecting", history: { BTC: [], ETH: [] } });

const midOf = (snapshot: MarketSnapshot, market: Market) => Number(BigInt(snapshot.markets[market].mid)) / 1e6;

export function MarketFeedProvider({ children }: { children: ReactNode }) {
  const [snapshot, setSnapshot] = useState<MarketSnapshot | null>(null);
  const [history, setHistory] = useState<History>({ BTC: [], ETH: [] });
  const [streamError, setStreamError] = useState(false);

  const status = useEventStream(`${MARKET_STREAM}/v1/markets/stream`, {
    markets: data => {
      const next = data as MarketSnapshot;
      if (!next?.markets?.BTC || !next.markets.ETH) return;
      setSnapshot(next); setStreamError(false);
      setHistory(current => ({
        BTC: [...current.BTC, midOf(next, "BTC")].slice(-HISTORY_POINTS),
        ETH: [...current.ETH, midOf(next, "ETH")].slice(-HISTORY_POINTS),
      }));
    },
    "stream-error": () => setStreamError(true),
  });

  useEffect(() => {
    const controller = new AbortController();
    for (const market of MARKETS) {
      getJson<{ points?: Array<{ mid: string }> }>(`${MARKET_STREAM}/v1/markets/history?market=${market}&limit=${HISTORY_POINTS}`, controller.signal)
        .then(value => {
          const prior = (value.points ?? []).map(point => Number(BigInt(point.mid)) / 1e6);
          setHistory(current => ({ ...current, [market]: [...prior, ...current[market]].slice(-HISTORY_POINTS) }));
        })
        .catch(() => { /* chart starts from the live stream instead */ });
    }
    return () => controller.abort();
  }, []);

  return <MarketFeedContext.Provider value={{ snapshot, status: streamError ? "reconnecting" : status, history }}>{children}</MarketFeedContext.Provider>;
}

export const useMarketFeed = () => useContext(MarketFeedContext);

/** Re-renders on an interval; used to age quotes and detect stale prices. */
export function useNow(intervalMs = 500) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), intervalMs); return () => clearInterval(timer); }, [intervalMs]);
  return now;
}
