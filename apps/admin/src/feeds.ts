// The dashboard's two live feeds. Both are read-only GETs.
// Locally the browser calls the indexer (:4300) and hedger (:4400) directly with the development operations
// token. On Cloudflare the page is served behind Access and both feeds are same-origin paths that the
// private edge forwards to the runtime (deploy/cloudflare/static/private-edge.mjs), which adds the hedger's
// token itself, so the browser never holds one.
import { useEffect, useState } from "react";
import { readSseEvents } from "../../../packages/shared/src/sse-events.js";
import { failureMessage, type HedgeStatus, type RiskSnapshot } from "./model.js";

// import.meta.env is Vite's; unit tests import this module under plain Node, where it is undefined.
const env: Partial<ImportMetaEnv> = import.meta.env ?? {};
const INDEXER = env.VITE_INDEXER_URL ?? (env.DEV ? "http://127.0.0.1:4300" : "");
const HEDGER = env.VITE_HEDGER_URL ?? (env.DEV ? "http://127.0.0.1:4400" : "");
// Development only: a production bundle never carries a bearer token (anyone who can fetch the JS could read it).
const HEDGE_TOKEN = env.DEV ? (env.VITE_HEDGE_OPS_TOKEN ?? "local-development-hedge-token") : undefined;

export const backoff = (attempt: number) => Math.min(15_000, 1_000 * 2 ** attempt);
const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((done) => {
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", () => (clearTimeout(timer), done()), { once: true });
  });

export type HedgeFeed = { status?: HedgeStatus; connected: boolean; error?: string };

/** The hedger's status stream, reconnecting with backoff. Keeps the last status while reconnecting. */
export function useHedgeFeed(): HedgeFeed {
  const [feed, setFeed] = useState<HedgeFeed>({ connected: false });
  useEffect(() => {
    const controller = new AbortController(),
      { signal } = controller;
    void (async () => {
      for (let attempt = 0; !signal.aborted; ) {
        let error: string;
        try {
          const response = await fetch(`${HEDGER}/v1/status/stream`, {
            headers: { accept: "text/event-stream", ...(HEDGE_TOKEN ? { authorization: `Bearer ${HEDGE_TOKEN}` } : {}) },
            credentials: HEDGE_TOKEN ? "omit" : "same-origin",
            signal,
          });
          if (!response.ok || !response.body)
            throw new Error(failureMessage("hedger", response.status, await response.text().catch(() => "")));
          for await (const event of readSseEvents(response.body)) {
            if (event.event !== "status") continue;
            attempt = 0;
            setFeed({ status: JSON.parse(event.data) as HedgeStatus, connected: true });
          }
          error = "Hedger stream closed. Reconnecting.";
        } catch (reason) {
          if (signal.aborted) return;
          error = reason instanceof TypeError ? "Cannot reach the hedger. Retrying." : (reason as Error).message;
        }
        setFeed((current) => ({ ...current, connected: false, error }));
        await sleep(backoff(attempt++), signal);
      }
    })();
    return () => controller.abort();
  }, []);
  return feed;
}

export type RiskFeed = { risk?: RiskSnapshot; error?: string };

/** The indexer's finalized risk view, re-read whenever the indexer reports a new block. */
export function useRiskFeed(): RiskFeed {
  const [feed, setFeed] = useState<RiskFeed>({});
  useEffect(() => {
    const controller = new AbortController();
    let loading = false,
      again = false,
      retry: ReturnType<typeof setTimeout> | undefined;
    const load = async (): Promise<void> => {
      if (loading) return void (again = true);
      loading = true;
      clearTimeout(retry);
      try {
        const response = await fetch(`${INDEXER}/v1/risk?finalized=true`, { signal: controller.signal });
        if (!response.ok)
          throw new Error(failureMessage("indexer", response.status, await response.text().catch(() => "")));
        const risk = (await response.json()) as RiskSnapshot;
        setFeed({ risk });
      } catch (reason) {
        if (controller.signal.aborted) return;
        const error = reason instanceof TypeError ? "Cannot reach the indexer. Retrying." : (reason as Error).message;
        setFeed((current) => ({ ...current, error }));
        retry = setTimeout(() => void load(), 5_000);
      } finally {
        loading = false;
      }
      if (again) {
        again = false;
        return load();
      }
    };
    void load();
    // EventSource reconnects by itself; every "indexed" event (including the first) triggers a re-read.
    const updates = new EventSource(`${INDEXER}/v1/updates/stream`);
    updates.addEventListener("indexed", () => void load());
    return () => {
      controller.abort();
      clearTimeout(retry);
      updates.close();
    };
  }, []);
  return feed;
}

/** The current time, ticking every second, so "updated 3s ago" stays true without new data. */
export function useNow(intervalMs = 1_000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}
