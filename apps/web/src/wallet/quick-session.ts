// The trading key: a browser key the user authorizes on-chain once (grantSessionWithSignature) when they
// connect, so every trade after that fills with one tap. It has no trading limit of its own (the markets' risk
// limits still apply on chain) and lasts a week. It can only trade: withdrawals and margin moves out always need
// the wallet. The key is kept in this browser's localStorage so trading survives reloads, as on other perp venues;
// disconnecting the wallet deletes it.
import { useCallback, useEffect, useState } from "react";
import { formatUnits, type Hex } from "viem";

/** How long a trading key lasts. The approvers only honour an account's newest key granted this recently. */
export const QUICK_DAYS = 7;
/**
 * What a trading key may sign: anything the protocol allows. Per trade, the largest position any market may
 * hold (`RFQTypes.ABSOLUTE_MAX_MARKET_NOTIONAL`, 5M USDC), so every close fits; in total, no limit (uint128
 * max). Opening trades stay bounded by each market's own per-trade cap, which the contract enforces.
 */
export const SESSION_LIMITS = {
  maxTradeMicro: 5_000_000_000_000n,
  maxCumulativeMicro: (1n << 128n) - 1n,
} as const;
/**
 * The key's fee cap per trade, in bps of its per-trade limit: room for the 4 bps trading fee and an
 * operator-raised one. A trade whose fee would pass the cap falls back to the wallet.
 */
export const QUICK_FEE_BPS = 10n;
/** The per-trade fee cap (USDC micro) every key is granted. */
export const SESSION_MAX_FEE = (SESSION_LIMITS.maxTradeMicro * QUICK_FEE_BPS + 9_999n) / 10_000n;

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

/** Body fields of POST /v1/session/prepare for a trading key over all `marketCount` markets. */
export const quickSessionRequest = (marketCount: number) => ({
  maxTradeAmount: formatUnits(SESSION_LIMITS.maxTradeMicro, 6),
  maxCumulativeAmount: formatUnits(SESSION_LIMITS.maxCumulativeMicro, 6),
  maxFee: formatUnits(SESSION_MAX_FEE, 6),
  durationSeconds: QUICK_DAYS * 24 * 60 * 60,
  marketMask: allMarketsMask(marketCount),
});

/** Whether `mask` (number or decimal string) includes market `index`. */
export const maskIncludes = (mask: number | string, index: number) =>
  index >= 0 && ((BigInt(mask) >> BigInt(index)) & 1n) === 1n;

/**
 * `marketMask` is the granted mask, `maxTradeNotional` the granted per-trade cap and `maxFee` the per-trade
 * fee cap (USDC micro), all decimal strings. Sessions saved before the mask was stored cover the launch
 * markets (3). Keys granted with a per-trade cap below {@link SESSION_LIMITS} (or none stored) date from when
 * keys were capped, and keys without a fee cap from when trades carried no fee: both are dropped, so the
 * next trade connects again with an uncapped key.
 */
export type QuickSession = {
  account: string;
  sessionAddress: string;
  validUntil: number;
  privateKey?: Hex;
  marketMask?: string;
  maxTradeNotional: string;
  maxFee: string;
};

const storageKey = (account: string) => `rfq-session:${account.toLowerCase()}`;
const SAFETY_MARGIN_MS = 30_000;
const live = (session: QuickSession | null) =>
  !!session && session.validUntil > Date.now() + SAFETY_MARGIN_MS;
const PRIVATE_KEY = /^0x[0-9a-f]{64}$/i;

/** Deletes every trading key this browser holds; the grants stay on chain until they expire or are revoked. */
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
      typeof parsed.maxFee !== "string" ||
      !/^\d{1,39}$/.test(parsed.maxFee) ||
      typeof parsed.maxTradeNotional !== "string" ||
      !/^\d{1,39}$/.test(parsed.maxTradeNotional) ||
      BigInt(parsed.maxTradeNotional) < SESSION_LIMITS.maxTradeMicro ||
      !live(parsed)
    )
      return null;
    return {
      account: parsed.account,
      sessionAddress: parsed.sessionAddress,
      validUntil: parsed.validUntil,
      maxFee: parsed.maxFee,
      marketMask:
        typeof parsed.marketMask === "string" && /^\d{1,39}$/.test(parsed.marketMask)
          ? parsed.marketMask
          : undefined,
      maxTradeNotional: parsed.maxTradeNotional,
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
 * cap, its fee at `feeBps` fits the key's fee cap and, when `marketIndex` is given,
 * the market is in the granted mask (a market added after the grant is not). The
 * cumulative cap is enforced on chain; a trade beyond it fails and should be
 * retried with the wallet.
 */
export const sessionCovers = (
  session: QuickSession | null,
  amountMicro: bigint,
  marketIndex?: number,
  feeBps: bigint | number = 0,
) =>
  live(session) &&
  !!session!.privateKey &&
  amountMicro <= BigInt(session!.maxTradeNotional) &&
  (amountMicro * BigInt(feeBps) + 9_999n) / 10_000n <= BigInt(session!.maxFee) &&
  (marketIndex === undefined || maskIncludes(session!.marketMask ?? "3", marketIndex));
