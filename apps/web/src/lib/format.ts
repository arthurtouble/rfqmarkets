// Display formatting for wire amounts (USDC 1e6, base 1e18, bps).
import type { Market } from "./types.js";

// signDisplay "negative" drops the sign from amounts that round to zero ("-$0.00").
const usd = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
  signDisplay: "negative",
});
const qty = new Intl.NumberFormat("en-US", { maximumFractionDigits: 4 });
// Below one unit, four significant digits, so a small position reads 0.00002183 BTC instead of 0.
const smallQty = new Intl.NumberFormat("en-US", { maximumSignificantDigits: 4 });

const toBig = (value: string | bigint) => (typeof value === "bigint" ? value : BigInt(value));
export const abs = (value: bigint) => (value < 0n ? -value : value);

/** Fixed-point integer to a JS number, for display only. */
export const scaled = (value: string | bigint, decimals: number) => Number(toBig(value)) / 10 ** decimals;

export const usdc = (micro?: string | bigint | null) =>
  micro === undefined || micro === null ? "—" : usd.format(scaled(micro, 6));
/**
 * Decimals a price shows: cents from $10 up, else about five significant digits ("$3.4567", "$0.12346",
 * "$0.000012"), never finer than the 1e6 wire precision. Prices only; money amounts use `usdc`.
 */
export function priceDecimals(dollars: number): number {
  const size = Math.abs(dollars);
  if (!Number.isFinite(size) || size === 0 || size >= 10) return 2;
  return Math.min(6, Math.max(2, 4 - Math.floor(Math.log10(size))));
}
const priceFormats = new Map<string, Intl.NumberFormat>();
function priceFormat(decimals: number, signed: boolean) {
  const key = `${decimals}:${signed}`;
  let format = priceFormats.get(key);
  if (!format) {
    format = new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
      signDisplay: signed ? "exceptZero" : "negative",
    });
    priceFormats.set(key, format);
  }
  return format;
}
/**
 * A price in dollars, as a number (charts, scrubbing). `decimals` defaults to what the price itself needs;
 * pass `priceDecimals(reference)` to keep a set of prices (an axis, a change) at one precision.
 */
export const usdPriceNumber = (dollars: number, decimals = priceDecimals(dollars), signed = false) =>
  priceFormat(decimals, signed).format(dollars);
/** A wire price (USDC 1e6) for display: "$97,412.50", "$0.12346". For money amounts use `usdc`. */
export const usdPrice = (micro?: string | bigint | null) =>
  micro === undefined || micro === null ? "—" : usdPriceNumber(scaled(micro, 6));

/** Like `usdc`, without cents on whole amounts ("$250", "$12.50"). */
export const usdcCompact = (micro?: string | bigint | null) => usdc(micro).replace(/\.00$/, "");
/** A trading fee: "None" at zero (trades carry no fee; the platform's charge is in the price). */
export const feeLabel = (micro?: string | bigint | null) =>
  micro === undefined || micro === null ? "—" : toBig(micro) === 0n ? "None" : usdc(micro);
export const signedUsdc = (micro?: string | bigint | null) => {
  if (micro === undefined || micro === null) return "—";
  return `${toBig(micro) >= 5_000n ? "+" : ""}${usdc(micro)}`;
};
export const baseAmount = (value?: string | bigint | null) => {
  if (value === undefined || value === null) return "—";
  const amount = scaled(value, 18);
  return (Math.abs(amount) < 1 ? smallQty : qty).format(amount);
};
export const signedBase = (value: string | bigint, market: Market) =>
  `${toBig(value) > 0n ? "+" : ""}${baseAmount(value)} ${market}`;

export const bpsPercent = (bps?: string | number | null) =>
  bps === undefined || bps === null ? "—" : `${(Number(bps) / 100).toFixed(2)}%`;
export const bpsLeverage = (bps?: string | null) => {
  if (bps === undefined || bps === null) return "—";
  const value = Number(bps);
  return value > 0 && value < 100 ? "<0.01×" : `${(value / 10_000).toFixed(2)}×`;
};
/** fundingApr is a 1e12-scaled annual rate. */
export const fundingApr = (rate?: string) => (rate === undefined ? "—" : `${scaled(rate, 10).toFixed(2)}%`);

export const shortAddress = (address: string) => `${address.slice(0, 6)}…${address.slice(-4)}`;
export const shortHash = (hash: string) => `${hash.slice(0, 10)}…`;
export const clockTime = (ms: number) =>
  new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
/** Date and time for history rows: "Oct 7, 17:13" in the viewer's locale, with the year when it is not this year's. */
export const dateTime = (ms: number, now = Date.now()) => {
  const date = new Date(ms);
  return date.toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    ...(date.getFullYear() === new Date(now).getFullYear() ? {} : { year: "numeric" }),
  });
};
export const sentence = (camel: string) => camel.replace(/([a-z])([A-Z])/g, "$1 $2");

const DECIMAL = /^\d+(\.\d*)?$/;
/** Parses a user-typed USDC amount; null unless it is a positive decimal with at most 6 places. */
export function parseUsdcInput(text: string): bigint | null {
  const value = text.trim().replace(/,/g, "");
  if (!DECIMAL.test(value)) return null;
  const [whole, fraction = ""] = value.split(".");
  if (fraction.length > 6) return null;
  const micro = BigInt(whole) * 1_000_000n + BigInt((fraction + "000000").slice(0, 6));
  return micro > 0n ? micro : null;
}
/** 1e6 integer to a plain decimal string suitable for an input or API field. */
export function microToInput(micro: bigint): string {
  const whole = micro / 1_000_000n,
    fraction = (micro % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole.toString();
}
