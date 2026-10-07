// What the order ticket remembers on this device: the last amount and
// leverage per market, and the slippage tolerance. Storage can be missing
// (private windows), so every read and write is guarded.
import { useCallback, useMemo, useState } from "react";
import { DEFAULT_SLIPPAGE_BPS, isValidSlippageBps } from "../lib/slippage.js";
import { parseTicketMemory, type TicketMemory } from "../lib/ticket.js";
import type { Market } from "../lib/types.js";

const read = (key: string) => { try { return localStorage.getItem(key); } catch { return null; } };
const write = (key: string, value: string) => { try { localStorage.setItem(key, value); } catch { /* storage unavailable */ } };

export function useTicketMemory(market: Market) {
  const key = `rfq.ticket.${market}`;
  const initial = useMemo(() => parseTicketMemory(read(key)), [key]);
  const save = useCallback((patch: Partial<TicketMemory>) => {
    write(key, JSON.stringify({ ...parseTicketMemory(read(key)), ...patch }));
  }, [key]);
  return { initial, save };
}

export function useSlippage(): [number, (bps: number) => void] {
  const [bps, setBps] = useState(() => {
    const stored = Number(read("rfq.slippageBps"));
    return isValidSlippageBps(stored) ? stored : DEFAULT_SLIPPAGE_BPS;
  });
  const choose = useCallback((next: number) => { if (isValidSlippageBps(next)) { setBps(next); write("rfq.slippageBps", String(next)); } }, []);
  return [bps, choose];
}
