export const API = import.meta.env.VITE_API_URL ?? "http://127.0.0.1:4100";
export const INDEXER = import.meta.env.VITE_INDEXER_URL ?? "http://127.0.0.1:4300";

export const dollars = (micro?: string) => micro
  ? new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 }).format(Number(BigInt(micro)) / 1e6)
  : "—";

export const base = (value?: string, decimals = 18) => value
  ? new Intl.NumberFormat("en-US", { maximumFractionDigits: 4 }).format(Number(BigInt(value)) / 10 ** decimals)
  : "0";

export const shortAddress = (address: string) => `${address.slice(0, 6)}…${address.slice(-4)}`;

export async function getJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error(`Request failed (${response.status})`);
  return response.json() as Promise<T>;
}
