// Volume fee tiers. Like Hyperliquid, the tier comes from rolling 14-day trade volume, assessed once a day at
// UTC midnight, and isolated accounts count towards their owner. Discounts mirror Hyperliquid's taker
// schedule (0.045% -> 0.040% -> 0.035% -> 0.030% -> 0.028%) as a share off the venue's base fee.

const USDC = 1_000_000n;
const DAY_MS = 86_400_000;
export const FEE_TIER_WINDOW_DAYS = 14;

export interface FeeTier {
  tier: number;
  /** Lowest 14-day volume (USDC micro-units) that reaches this tier. */
  minVolume: bigint;
  /** Share of the base fee waived, in bps (1_000 = 10% off). */
  discountBps: number;
}

export const FEE_TIERS: readonly FeeTier[] = [
  { tier: 0, minVolume: 0n, discountBps: 0 },
  { tier: 1, minVolume: 5_000_000n * USDC, discountBps: 1_100 },
  { tier: 2, minVolume: 25_000_000n * USDC, discountBps: 2_200 },
  { tier: 3, minVolume: 100_000_000n * USDC, discountBps: 3_300 },
  { tier: 4, minVolume: 500_000_000n * USDC, discountBps: 3_800 },
];

/** The highest tier `volume` reaches. */
export function feeTierFor(volume: bigint, tiers: readonly FeeTier[] = FEE_TIERS) {
  let reached = tiers[0];
  for (const tier of tiers) if (volume >= tier.minVolume) reached = tier;
  return reached;
}

/** The tier after `tier`, if any. */
export const nextFeeTier = (tier: FeeTier, tiers: readonly FeeTier[] = FEE_TIERS) =>
  tiers.find((candidate) => candidate.tier === tier.tier + 1);

/** The fee after the discount; the waived part rounds down, so the fee never rounds below the schedule. */
export const discountedFee = (fee: bigint, discountBps: number) =>
  fee - (fee * BigInt(discountBps)) / 10_000n;

/** The volume window a tier is assessed on at `nowMs`: the 14 full UTC days before today. */
export function feeTierWindow(nowMs: number) {
  const endMs = Math.floor(nowMs / DAY_MS) * DAY_MS;
  return { startMs: endMs - FEE_TIER_WINDOW_DAYS * DAY_MS, endMs };
}
