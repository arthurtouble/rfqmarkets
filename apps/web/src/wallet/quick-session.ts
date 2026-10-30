// Quick trading: a browser key the user authorizes on-chain once (grantSessionWithSignature),
// bounded by per-trade, cumulative and fee caps and a week's expiry. It can only trade within those
// caps: withdrawals and margin moves out always need the wallet. The key is kept in this browser's
// localStorage so one-click trading survives reloads, as on other perp venues; disconnecting the
// wallet or turning one-click off deletes it, and revoking the grant on chain disables it everywhere.
import { useCallback, useEffect, useState } from "react";
import { formatUnits, type Hex } from "viem";

/** How long a one-tap key lasts. The approvers only honour an account's newest key granted this recently. */
export const QUICK_DAYS = 7;
/** Trades carry no fee (the spread is in the price), so the fee cap is the smallest the contract accepts. */
const QUICK_MAX_FEE = "0.000001";
/** No one-tap key may sign more than this a trade or in total, whatever the markets allow (USDC micro). */
export const QUICK_CEILING = {
  maxTradeMicro: 1_000_000_000_000n,
  maxCumulativeMicro: 100_000_000_000_000n,
} as const;
/** The per-trade cap of keys saved before the cap was stored with them: the ceiling back then. */
export const LEGACY_MAX_TRADE_MICRO = 2_500_000_000n;
/** Round trips one key covers (at its largest size) before the wallet signs again. */
const QUICK_TRADES = 100n;

export type QuickLimits = { maxTradeMicro: bigint; maxCumulativeMicro: bigint };

/**
 * One-tap limits sized to the markets' per-trade caps (USDC micro): twice the largest, rounded up to a
 * dollar, so a winning exit still fits, and enough in total for {@link QUICK_TRADES} round trips. Never
 * above {@link QUICK_CEILING}; with no caps known, the ceiling. A trade past these limits, closes
 * included, falls back to the wallet.
 */
export function quickLimits(tradeCapsMicro: readonly bigint[]): QuickLimits {
  const largest = tradeCapsMicro.reduce((max, cap) => (cap > max ? cap : max), 0n),
    doubled = ((largest * 2n + 999_999n) / 1_000_000n) * 1_000_000n,
    min = (a: bigint, b: bigint) => (a < b ? a : b);
  const maxTradeMicro =
    largest > 0n ? min(doubled, QUICK_CEILING.maxTradeMicro) : QUICK_CEILING.maxTradeMicro;
  return {
    maxTradeMicro,
    maxCumulativeMicro: min(maxTradeMicro * 2n * QUICK_TRADES, QUICK_CEILING.maxCumulativeMicro),
  };
}

/** `RFQTypes.MAX_MARKETS`. */
const MAX_MARKETS = 128;

/**
 * The session `marketMask` covering every registered market (bit i = market
 * index i): `(1 << count) - 1`. A JSON number while it fits in 53 bits, else
 * the decimal string the API accepts for wider masks.
 */
export function allMarketsMask(marketCount: number): number | string {
  if (!Number.isInteger(marketCount) || marketCount < 1 || marketCount > MAX_MARKETS)
    throw new Error("invalid market count");
  const mask = (1n << BigInt(marketCount)) - 1n;
  return marketCount <= 53 ? Number(mask) : mask.toString();
}

/** Body fields of POST /v1/session/prepare for a quick-trading key over all `marketCount` markets. */
export const quickSessionRequest = (marketCount: number, limits: QuickLimits) => ({
  maxTradeAmount: formatUnits(limits.maxTradeMicro, 6),
  maxCumulativeAmount: formatUnits(limits.maxCumulativeMicro, 6),
  maxFee: QUICK_MAX_FEE,
  durationSeconds: QUICK_DAYS * 24 * 60 * 60,
  marketMask: allMarketsMask(marketCount),
});

/** Whether `mask` (number or decimal string) includes market `index`. */
export const maskIncludes = (mask: number | string, index: number) =>
  index >= 0 && ((BigInt(mask) >> BigInt(index)) & 1n) === 1n;

/**
 * `marketMask` is the granted mask and `maxTradeNotional` the granted per-trade cap (USDC micro), both
 * decimal strings. Sessions saved before they were stored cover the launch markets (3) and the ceiling.
 */
export type QuickSession = {
  account: string;
  sessionAddress: string;
  validUntil: number;
  privateKey?: Hex;
  marketMask?: string;
  maxTradeNotional?: string;
};

const storageKey = (account: string) => `rfq-session:${account.toLowerCase()}`;
const SAFETY_MARGIN_MS = 30_000;
const live = (session: QuickSession | null) =>
  !!session && session.validUntil > Date.now() + SAFETY_MARGIN_MS;
const PRIVATE_KEY = /^0x[0-9a-f]{64}$/i;

/** Deletes every one-tap key this browser holds; the grants stay on chain until they expire or are revoked. */
export function forgetSessionKeys() {
  try {
    for (const key of Object.keys(localStorage))
      if (key.startsWith("rfq-session:")) localStorage.removeItem(key);
  } catch {
    /* nothing stored */
  }
}

function load(account: string | null): QuickSession | null {
  if (!account) return null;
  try {
    const parsed = JSON.parse(localStorage.getItem(storageKey(account)) ?? "null") as QuickSession | null;
    if (
      !parsed ||
      parsed.account.toLowerCase() !== account.toLowerCase() ||
      !/^0x[0-9a-f]{40}$/i.test(parsed.sessionAddress) ||
      !live(parsed)
    )
      return null;
    return {
      account: parsed.account,
      sessionAddress: parsed.sessionAddress,
      validUntil: parsed.validUntil,
      marketMask:
        typeof parsed.marketMask === "string" && /^\d{1,39}$/.test(parsed.marketMask)
          ? parsed.marketMask
          : undefined,
      maxTradeNotional:
        typeof parsed.maxTradeNotional === "string" && /^\d{1,39}$/.test(parsed.maxTradeNotional)
          ? parsed.maxTradeNotional
          : undefined,
      privateKey:
        typeof parsed.privateKey === "string" && PRIVATE_KEY.test(parsed.privateKey)
          ? parsed.privateKey
          : undefined,
    };
  } catch {
    return null;
  }
}

export function useQuickSession(account: string | null) {
  const [session, setSession] = useState<QuickSession | null>(() => load(account));
  useEffect(() => setSession(load(account)), [account]);
  const save = useCallback((value: QuickSession) => {
    try {
      localStorage.setItem(storageKey(value.account), JSON.stringify(value));
    } catch {
      /* private window: the key lasts until this tab reloads */
    }
    setSession(value);
  }, []);
  const clear = useCallback(() => {
    if (account)
      try {
        localStorage.removeItem(storageKey(account));
      } catch {
        /* nothing stored */
      }
    setSession(null);
  }, [account]);
  return { session: live(session) ? session : null, save, clear };
}

/**
 * Whether a trade of `amountMicro` USDC can be signed with the session key: the
 * session is live, its key is in this browser, the amount is within the per-trade
 * cap and, when `marketIndex` is given, the market is in the granted mask (a
 * market added after the grant is not). The cumulative cap is enforced on
 * chain; a trade beyond it fails and should be retried with the wallet.
 */
export const sessionCovers = (session: QuickSession | null, amountMicro: bigint, marketIndex?: number) =>
  live(session) &&
  !!session!.privateKey &&
  amountMicro <= BigInt(session!.maxTradeNotional ?? LEGACY_MAX_TRADE_MICRO) &&
  (marketIndex === undefined || maskIncludes(session!.marketMask ?? "3", marketIndex));
