// Quick trading: a short-lived browser key the user authorizes on-chain once
// (grantSessionWithSignature), bounded by per-trade, cumulative and fee caps.
// The private key stays in memory only. sessionStorage keeps the public
// session address so a reloaded tab can still revoke the grant.
import { useCallback, useEffect, useState } from "react";
import type { Hex } from "viem";

export const QUICK_LIMITS = {
  marketMask: 3, maxTradeAmount: "2500", maxCumulativeAmount: "10000", maxFee: "5", durationSeconds: 8 * 60 * 60,
} as const;

export type QuickSession = { account: string; sessionAddress: string; validUntil: number; privateKey?: Hex };

const storageKey = (account: string) => `rfq-session:${account.toLowerCase()}`;
const SAFETY_MARGIN_MS = 30_000;
const live = (session: QuickSession | null) => !!session && session.validUntil > Date.now() + SAFETY_MARGIN_MS;
const keys = new Map<string, Hex>();

function load(account: string | null): QuickSession | null {
  if (!account) return null;
  try {
    const parsed = JSON.parse(sessionStorage.getItem(storageKey(account)) ?? "null") as QuickSession | null;
    if (!parsed || parsed.account.toLowerCase() !== account.toLowerCase() || !/^0x[0-9a-f]{40}$/i.test(parsed.sessionAddress) || !live(parsed)) return null;
    return { account: parsed.account, sessionAddress: parsed.sessionAddress, validUntil: parsed.validUntil, privateKey: keys.get(parsed.sessionAddress.toLowerCase()) };
  } catch { return null; }
}

export function useQuickSession(account: string | null) {
  const [session, setSession] = useState<QuickSession | null>(() => load(account));
  useEffect(() => setSession(load(account)), [account]);
  const save = useCallback((value: QuickSession) => {
    if (value.privateKey) keys.set(value.sessionAddress.toLowerCase(), value.privateKey);
    const { privateKey: _secret, ...metadata } = value;
    try { sessionStorage.setItem(storageKey(value.account), JSON.stringify(metadata)); } catch { /* revocation needs the wallet's own history then */ }
    setSession(value);
  }, []);
  const clear = useCallback(() => {
    if (account) try { sessionStorage.removeItem(storageKey(account)); } catch { /* nothing stored */ }
    setSession(current => { if (current) keys.delete(current.sessionAddress.toLowerCase()); return null; });
  }, [account]);
  return { session: live(session) ? session : null, save, clear };
}

/** Whether a market order of `amountMicro` USDC can be signed with the session key. */
export const sessionCovers = (session: QuickSession | null, amountMicro: bigint) =>
  live(session) && !!session!.privateKey && amountMicro <= BigInt(QUICK_LIMITS.maxTradeAmount) * 1_000_000n;
