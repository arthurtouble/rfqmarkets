/**
 * Internal prices are fixed-point bigints with 18 decimals (USD or quote currency per unit), so
 * low-priced assets keep their precision through stablecoin conversion and lot multipliers.
 * Signed prices are USDC micro-units (6 decimals).
 */
export const PRICE_DECIMALS = 18;
export const PRICE_SCALE = 10n ** 18n;
const MICRO_DIVISOR = 10n ** 12n;

/** Parses a non-negative decimal string or JSON number (including exponent notation) exactly. */
export function parseDecimal(value: unknown, decimals = PRICE_DECIMALS): bigint {
  const text = typeof value === "number" ? (Number.isFinite(value) ? String(value) : "") : value;
  if (typeof text !== "string") throw new Error("price is not a decimal");
  const match = /^(\d+)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/.exec(text.trim());
  if (!match) throw new Error(`invalid decimal ${text}`);
  const [, whole, fraction = "", exponentText = "0"] = match;
  const exponent = Number(exponentText);
  if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > 60) throw new Error(`invalid decimal ${text}`);
  // value = digits * 10^(exponent - fraction.length); scale to `decimals` and truncate.
  const digits = BigInt(whole + fraction),
    shift = exponent - fraction.length + decimals;
  return shift >= 0 ? digits * 10n ** BigInt(shift) : digits / 10n ** BigInt(-shift);
}

/** Formats an 18-decimal price for logs and JSON (trailing zeros trimmed). */
export function formatPrice(value: bigint, decimals = PRICE_DECIMALS) {
  const negative = value < 0n,
    absolute = negative ? -value : value,
    scale = 10n ** BigInt(decimals),
    fraction = (absolute % scale).toString().padStart(decimals, "0").replace(/0+$/, "");
  return `${negative ? "-" : ""}${absolute / scale}${fraction ? `.${fraction}` : ""}`;
}

export const toMicroFloor = (price: bigint) => price / MICRO_DIVISOR;
export const toMicroCeil = (price: bigint) => (price + MICRO_DIVISOR - 1n) / MICRO_DIVISOR;
export const microToPrice = (micro: bigint) => micro * MICRO_DIVISOR;

export function compareBigint(a: bigint, b: bigint) {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Median; an even count averages the two middle values (floored). */
export function medianOf(values: readonly bigint[]) {
  if (!values.length) throw new Error("median of an empty set");
  const sorted = [...values].sort(compareBigint),
    middle = sorted.length >> 1;
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2n;
}

export const absDiff = (a: bigint, b: bigint) => (a > b ? a - b : b - a);
