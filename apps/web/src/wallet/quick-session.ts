// Quick trading: a short-lived browser key the user authorizes on-chain once
// (grantSessionWithSignature), bounded by per-trade, cumulative and fee caps.
// The private key stays in memory only. sessionStorage keeps the public
// session address so a reloaded tab can still revoke the grant.
import { useCallback, useEffect, useState } from "react";
import type { Hex } from "viem";

export const QUICK_LIMITS = {
  maxTradeAmount: "2500", maxCumulativeAmount: "10000", maxFee: "5", durationSeconds: 8 * 60 * 60,
} as const;

/** `RFQTypes.MAX_MARKETS`. */
const MAX_MARKETS = 128;

/**
 * The session `marketMask` covering every registered market (bit i = market
 * index i): `(1 << count) - 1`. A JSON number while it fits in 53 bits, else
 * the decimal string the API accepts for wider masks.
 */
export function allMarketsMask(marketCount: number): number | string {
  if (!Number.isInteger(marketCount) || marketCount < 1 || marketCount > MAX_MARKETS) throw new Error("invalid market count");
  const mask = (1n << BigInt(marketCount)) - 1n;
  return marketCount <= 53 ? Number(mask) : mask.toString();
}

/** Body fields of POST /v1/session/prepare for a quick-trading key over all `marketCount` markets. */
export const quickSessionRequest = (marketCount: number) => ({ ...QUICK_LIMITS, marketMask: allMarketsMask(marketCount) });

/** Whether `mask` (number or decimal string) includes market `index`. */
export const maskIncludes = (mask: number | string, index: number) =>
  index >= 0 && ((BigInt(mask) >> BigInt(index)) & 1n) === 1n;

/** `marketMask` is the granted mask as a decimal string; sessions saved before it existed cover the launch markets (3). */
export type QuickSession = { account: string; sessionAddress: string; validUntil: number; privateKey?: Hex; marketMask?: string };

const storageKey = (account: string) => `rfq-session:${account.toLowerCase()}`;
const SAFETY_MARGIN_MS = 30_000;
const live = (session: QuickSession | null) => !!session && session.validUntil > Date.now() + SAFETY_MARGIN_MS;
const keys = new Map<string, Hex>();

function load(account: string | null): QuickSession | null {
  if (!account) return null;
  try {
    const parsed = JSON.parse(sessionStorage.getItem(storageKey(account)) ?? "null") as QuickSession | null;
    if (!parsed || parsed.account.toLowerCase() !== account.toLowerCase() || !/^0x[0-9a-f]{40}$/i.test(parsed.sessionAddress) || !live(parsed)) return null;
    return { account: parsed.account, sessionAddress: parsed.sessionAddress, validUntil: parsed.validUntil, marketMask: typeof parsed.marketMask === "string" && /^\d{1,39}$/.test(parsed.marketMask) ? parsed.marketMask : undefined, privateKey: keys.get(parsed.sessionAddress.toLowerCase()) };
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

/**
 * Whether a trade of `amountMicro` USDC can be signed with the session key: the
 * session is live, its key is in this tab, the amount is within the per-trade
 * cap and, when `marketIndex` is given, the market is in the granted mask (a
 * market added after the grant is not). The cumulative cap is enforced on
 * chain; a trade beyond it fails and should be retried with the wallet.
 */
export const sessionCovers = (session: QuickSession | null, amountMicro: bigint, marketIndex?: number) =>
  live(session) && !!session!.privateKey && amountMicro <= BigInt(QUICK_LIMITS.maxTradeAmount) * 1_000_000n
  && (marketIndex === undefined || maskIncludes(session!.marketMask ?? "3", marketIndex));
