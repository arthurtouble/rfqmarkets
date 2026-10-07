// Display formatting for wire amounts (USDC 1e6, base 1e18, bps).
import type { Market } from "./types.js";

const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 });
const qty = new Intl.NumberFormat("en-US", { maximumFractionDigits: 4 });

const toBig = (value: string | bigint) => (typeof value === "bigint" ? value : BigInt(value));
export const abs = (value: bigint) => (value < 0n ? -value : value);

/** Fixed-point integer to a JS number, for display only. */
export const scaled = (value: string | bigint, decimals: number) => Number(toBig(value)) / 10 ** decimals;

export const usdc = (micro?: string | bigint | null) => (micro === undefined || micro === null ? "—" : usd.format(scaled(micro, 6)));
export const signedUsdc = (micro?: string | bigint | null) => {
  if (micro === undefined || micro === null) return "—";
  return `${toBig(micro) > 0n ? "+" : ""}${usdc(micro)}`;
};
export const baseAmount = (value?: string | bigint | null) => (value === undefined || value === null ? "—" : qty.format(scaled(value, 18)));
export const signedBase = (value: string | bigint, market: Market) => `${toBig(value) > 0n ? "+" : ""}${baseAmount(value)} ${market}`;

export const bpsPercent = (bps?: string | number | null) => (bps === undefined || bps === null ? "—" : `${(Number(bps) / 100).toFixed(2)}%`);
export const bpsLeverage = (bps?: string | null) => (bps === undefined || bps === null ? "—" : `${(Number(bps) / 10_000).toFixed(2)}×`);
/** fundingApr is a 1e12-scaled annual rate. */
export const fundingApr = (rate?: string) => (rate === undefined ? "—" : `${(scaled(rate, 10)).toFixed(2)}%`);

export const shortAddress = (address: string) => `${address.slice(0, 6)}…${address.slice(-4)}`;
export const shortHash = (hash: string) => `${hash.slice(0, 10)}…`;
export const clockTime = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
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
  const whole = micro / 1_000_000n, fraction = (micro % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole.toString();
}
