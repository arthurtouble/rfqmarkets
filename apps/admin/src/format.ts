// Display formatting for wire amounts: USDC has 6 decimals, base sizes 18.

const toBig = (value: string | bigint) => (typeof value === "bigint" ? value : BigInt(value));
const scaled = (value: string | bigint, decimals: number) => Number(toBig(value)) / 10 ** decimals;
const dollars = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0,
});
const cents = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
});

/** Whole dollars, for balances and notionals; cents below $100 so small dev amounts do not read as $0. */
export function usd(micro?: string | bigint | null) {
  if (micro === undefined || micro === null) return "—";
  const value = scaled(micro, 6);
  return Math.abs(value) < 100 && value !== 0 ? cents.format(value) : dollars.format(value);
}

/** A price with cents (limit prices). */
export const price = (micro?: string | bigint | null) =>
  micro === undefined || micro === null ? "—" : cents.format(scaled(micro, 6));

/** A base size with up to `digits` decimals, e.g. "0.0125". */
export function base(value?: string | bigint | null, digits = 4) {
  if (value === undefined || value === null) return "—";
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: digits }).format(scaled(value, 18));
}

/** A signed base size: "+0.5" or "−0.5" (true minus sign), "0" when flat. */
export function signedBase(value?: string | bigint | null, digits = 4) {
  if (value === undefined || value === null) return "—";
  const amount = toBig(value);
  if (amount === 0n) return "0";
  return `${amount > 0n ? "+" : "−"}${base(amount < 0n ? -amount : amount, digits)}`;
}

export const integer = (value?: number | null) =>
  value === undefined || value === null || value < 0 ? "—" : new Intl.NumberFormat("en-US").format(value);

export const percent = (value?: number) =>
  value === undefined ? "—" : `${value.toFixed(value < 10 ? 1 : 0)}%`;

export const clockTime = (ms?: number) =>
  ms ? new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "—";

export const shortId = (id: string) => (id.length > 14 ? `${id.slice(0, 8)}…${id.slice(-4)}` : id);
