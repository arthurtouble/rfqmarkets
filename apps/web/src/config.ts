const productionOrigin = import.meta.env.PROD ? "" : undefined;

export const API = import.meta.env.VITE_API_URL ?? productionOrigin ?? "http://127.0.0.1:4100";
export const INDEXER = import.meta.env.VITE_INDEXER_URL ?? productionOrigin ?? "http://127.0.0.1:4300";
export const MARKET_STREAM = import.meta.env.VITE_MARKET_STREAM_URL ?? productionOrigin ?? "http://127.0.0.1:4500";

export const dollars = (micro?: string) => {
  if (!micro) return "—";
  const amount = Number(BigInt(micro)) / 1e6;
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: amount !== 0 && Math.abs(amount) < 0.01 ? 6 : 2,
  }).format(amount);
};

export const base = (value?: string, decimals = 18) => value
  ? new Intl.NumberFormat("en-US", { maximumFractionDigits: 8 }).format(Number(BigInt(value)) / 10 ** decimals)
  : "0";

export const shortAddress = (address: string) => `${address.slice(0, 6)}…${address.slice(-4)}`;

export async function getJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error(`Request failed (${response.status})`);
  return response.json() as Promise<T>;
}
