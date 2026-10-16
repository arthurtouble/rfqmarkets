// The live market stream, shared by every page through context so the app
// holds one connection. Markets are whatever the stream carries (governance can
// add one at any time). Charts read candles (data/candles.ts), not this feed.
import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { serverClock } from "../lib/clock.js";
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

const MarketFeedContext = createContext<MarketFeed>({
  snapshot: null,
  status: "connecting",
  receivedAtMs: null,
  lastPrices: {},
});

/** Screens redraw at most this often however fast the stream ticks; quotes are firm server-side anyway. */
const FEED_INTERVAL_MS = 250;

export function MarketFeedProvider({ children }: { children: ReactNode }) {
  const [snapshot, setSnapshot] = useState<MarketSnapshot | null>(null);
  const [receivedAtMs, setReceivedAtMs] = useState<number | null>(null);
  const [lastPrices, setLastPrices] = useState<Record<Market, LastPrice>>({});
  const [streamError, setStreamError] = useState(false);
  const pending = useRef<MarketSnapshot | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastFlush = useRef(0);

  const flush = () => {
    timer.current = null;
    const next = pending.current;
    if (!next) return;
    pending.current = null;
    lastFlush.current = Date.now();
    setSnapshot(next);
    setReceivedAtMs(lastFlush.current);
    setStreamError(false);
    setLastPrices((current) => {
      const updated = { ...current };
      for (const [market, state] of Object.entries(next.markets))
        updated[market] = { mid: state.mid, observedAtMs: state.observedAtMs };
      return updated;
    });
  };
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const status = useEventStream(`${MARKET_STREAM}/v1/markets/stream`, {
    markets: (data) => {
      const next = data as MarketSnapshot;
      if (!next?.markets || typeof next.markets !== "object" || !Object.keys(next.markets).length) return;
      // Measured on arrival, before the redraw throttle holds the snapshot back.
      serverClock.observe(next.serverTimeMs, Date.now());
      pending.current = next;
      if (timer.current) return;
      // The first update after a quiet spell shows at once; a burst shows its latest every interval.
      const wait = lastFlush.current + FEED_INTERVAL_MS - Date.now();
      if (wait <= 0) flush();
      else timer.current = setTimeout(flush, wait);
    },
    "stream-error": () => setStreamError(true),
  });

  const shownStatus = streamError ? "reconnecting" : status;
  const value = useMemo(
    () => ({ snapshot, status: shownStatus, receivedAtMs, lastPrices }),
    [snapshot, shownStatus, receivedAtMs, lastPrices],
  );
  return <MarketFeedContext.Provider value={value}>{children}</MarketFeedContext.Provider>;
}

export const useMarketFeed = () => useContext(MarketFeedContext);

/** Re-renders on an interval; used to age quotes and detect stale prices. */
export function useNow(intervalMs = 500) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}

/**
 * The server's time, re-rendering on an interval: Date.now() corrected by the skew measured from the market
 * stream. Compare server timestamps (observedAtMs, expiresAtMs) with this, never with Date.now().
 */
export function useServerNow(intervalMs = 500) {
  return serverClock.now(useNow(intervalMs));
}

/** One market's live state and whether its price is live, delayed, paused or unavailable. */
export function useMarketPrice(market: Market): {
  live: MarketSnapshot["markets"][Market] | undefined;
  status: PriceStatus;
  last: LastPrice | undefined;
} {
  const { snapshot, status, receivedAtMs, lastPrices } = useMarketFeed();
  const now = useNow(2_000);
  const live = snapshot?.markets[market];
  return {
    live,
    last: lastPrices[market],
    status: priceStatus(live, {
      streamLive: status === "live",
      nowMs: now,
      receivedAtMs,
      serverTimeMs: snapshot?.serverTimeMs,
    }),
  };
}
