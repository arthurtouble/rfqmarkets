// The live market stream, shared by every page through context so the app
// holds one connection. History is seeded from the gateway, then extended.
// Markets are whatever the stream carries (governance can add one at any time);
// a market seen for the first time gets its history seeded then.
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { MARKET_STREAM } from "../lib/env.js";
import { useEventStream, type StreamStatus } from "../lib/event-stream.js";
import { getJson } from "../lib/http.js";
import { MARKETS, type Market, type MarketSnapshot } from "../lib/types.js";

const HISTORY_POINTS = 240;
/** Mid prices (USDC) per market, oldest first. A market not yet seen has no entry. */
type History = Record<Market, number[]>;
type MarketFeed = { snapshot: MarketSnapshot | null; status: StreamStatus; history: History };

const launchHistory = (): History => Object.fromEntries(MARKETS.map(market => [market, []]));
const MarketFeedContext = createContext<MarketFeed>({ snapshot: null, status: "connecting", history: launchHistory() });

const midOf = (snapshot: MarketSnapshot, market: Market) => Number(BigInt(snapshot.markets[market].mid)) / 1e6;

export function MarketFeedProvider({ children }: { children: ReactNode }) {
  const [snapshot, setSnapshot] = useState<MarketSnapshot | null>(null);
  const [history, setHistory] = useState<History>(launchHistory);
  const [streamError, setStreamError] = useState(false);
  const [seen, setSeen] = useState<readonly Market[]>(MARKETS);
  const seeded = useRef(new Set<Market>());

  const status = useEventStream(`${MARKET_STREAM}/v1/markets/stream`, {
    markets: data => {
      const next = data as MarketSnapshot;
      if (!next?.markets || typeof next.markets !== "object" || !Object.keys(next.markets).length) return;
      setSnapshot(next); setStreamError(false);
      setHistory(current => {
        const updated: History = { ...current };
        for (const market of Object.keys(next.markets))
          updated[market] = [...(current[market] ?? []), midOf(next, market)].slice(-HISTORY_POINTS);
        return updated;
      });
      setSeen(current => (Object.keys(next.markets).every(market => current.includes(market)) ? current : [...new Set([...current, ...Object.keys(next.markets)])]));
    },
    "stream-error": () => setStreamError(true),
  });

  // One controller for the provider's lifetime: a newly seen market must not cancel another's seed.
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => { controller.current?.abort(); controller.current = null; seeded.current.clear(); }, []);

  useEffect(() => {
    controller.current ??= new AbortController();
    const { signal } = controller.current;
    for (const market of seen) {
      if (seeded.current.has(market)) continue;
      seeded.current.add(market);
      getJson<{ points?: Array<{ mid: string }> }>(`${MARKET_STREAM}/v1/markets/history?market=${encodeURIComponent(market)}&limit=${HISTORY_POINTS}`, signal)
        .then(value => {
          const prior = (value.points ?? []).map(point => Number(BigInt(point.mid)) / 1e6);
          setHistory(current => ({ ...current, [market]: [...prior, ...(current[market] ?? [])].slice(-HISTORY_POINTS) }));
        })
        .catch(() => { /* chart starts from the live stream instead */ });
    }
  }, [seen]);

  return <MarketFeedContext.Provider value={{ snapshot, status: streamError ? "reconnecting" : status, history }}>{children}</MarketFeedContext.Provider>;
}

export const useMarketFeed = () => useContext(MarketFeedContext);

/** Re-renders on an interval; used to age quotes and detect stale prices. */
export function useNow(intervalMs = 500) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), intervalMs); return () => clearInterval(timer); }, [intervalMs]);
  return now;
}
