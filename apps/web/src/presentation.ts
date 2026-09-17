import { dollars } from "./config.js";

export const signedDollars = (value?: string) => value === undefined
  ? "—"
  : `${BigInt(value) > 0n ? "+" : ""}${dollars(value)}`;

export const ratio = (bps?: string | null) => bps === null || bps === undefined
  ? "—"
  : `${(Number(bps) / 100).toFixed(2)}%`;

export const leverage = (bps?: string | null) => bps === null || bps === undefined
  ? "—"
  : `${(Number(bps) / 10_000).toFixed(2)}×`;

export const inputDollars = (value: string) => new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 2,
}).format(Number(value));
