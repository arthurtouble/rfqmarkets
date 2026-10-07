// One Server-Sent Events subscription that survives HTTP errors.
// EventSource retries dropped connections itself but gives up for good after
// a non-200 response, so a closed source is recreated with capped backoff.
import { useEffect, useRef, useState } from "react";

export type StreamStatus = "connecting" | "live" | "reconnecting";

export function backoffDelay(attempt: number, baseMs = 1_000, maxMs = 30_000) {
  return Math.min(maxMs, baseMs * 2 ** Math.min(attempt, 10));
}

export function useEventStream(url: string | null, handlers: Record<string, (data: unknown) => void>): StreamStatus {
  const [status, setStatus] = useState<StreamStatus>("connecting");
  const latest = useRef(handlers);
  latest.current = handlers;
  const events = Object.keys(handlers).sort().join(",");

  useEffect(() => {
    if (!url) return;
    let source: EventSource | null = null, timer: ReturnType<typeof setTimeout> | undefined, attempt = 0, stopped = false;
    const open = () => {
      source = new EventSource(url);
      source.onopen = () => { attempt = 0; setStatus("live"); };
      source.onerror = () => {
        setStatus("reconnecting");
        if (source?.readyState !== EventSource.CLOSED || stopped) return;
        timer = setTimeout(open, backoffDelay(attempt++));
      };
      for (const name of events.split(",")) {
        source.addEventListener(name, event => {
          let data: unknown;
          try { data = JSON.parse((event as MessageEvent<string>).data); } catch { return; }
          latest.current[name]?.(data);
        });
      }
    };
    setStatus("connecting");
    open();
    return () => { stopped = true; clearTimeout(timer); source?.close(); };
  }, [url, events]);

  return status;
}
