// What the order ticket remembers on this device: the last amount and
// leverage per market, and the slippage tolerance. Storage can be missing
// (private windows), so lib/storage guards every read and write.
import { useCallback, useMemo, useState } from "react";
import { DEFAULT_SLIPPAGE_BPS, isValidSlippageBps } from "../lib/slippage.js";
import { parseTicketMemory, type TicketMemory } from "../lib/ticket.js";
import type { Market } from "../lib/types.js";
import { load, store } from "../lib/storage.js";

const read = load,
  write = store;

export function useTicketMemory(market: Market) {
  const key = `rfq.ticket.${market}`;
  const initial = useMemo(() => parseTicketMemory(read(key)), [key]);
  const save = useCallback(
    (patch: Partial<TicketMemory>) => {
      write(key, JSON.stringify({ ...parseTicketMemory(read(key)), ...patch }));
    },
    [key],
  );
  return { initial, save };
}

export function useSlippage(): [number, (bps: number) => void] {
  const [bps, setBps] = useState(() => {
    const stored = Number(read("rfq.slippageBps"));
    return isValidSlippageBps(stored) ? stored : DEFAULT_SLIPPAGE_BPS;
  });
  const choose = useCallback((next: number) => {
    if (isValidSlippageBps(next)) {
      setBps(next);
      write("rfq.slippageBps", String(next));
    }
  }, []);
  return [bps, choose];
}
