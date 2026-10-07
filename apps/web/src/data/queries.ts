// Server state through TanStack Query. The indexer's update stream
// (useIndexerSync) invalidates these keys instead of polling.
import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { useConfig } from "wagmi";
import { getPublicClient } from "wagmi/actions";
import { erc20Abi, type Address } from "viem";
import { API, INDEXER } from "../lib/env.js";
import { useEventStream } from "../lib/event-stream.js";
import { getJson } from "../lib/http.js";
import type { AccountState, Activity, ActivityPage, FillPage, FundingPage, IndexerHealth, Market, Portfolio, PortfolioHistory, PortfolioInterval, Protocol, PublicPosition, RestingOrder, Risk } from "../lib/types.js";
import { useTrader } from "../wallet/trader.js";

export const keys = {
  account: (address: string) => ["account", address.toLowerCase()] as const,
  indexer: ["indexer"] as const,
  /** Under the account key, so the indexer stream refreshes them on that account's activity. */
  portfolio: (address: string) => [...keys.account(address), "portfolio"] as const,
  orders: (address: string) => [...keys.account(address), "orders"] as const,
};

export function useAccountState(address: string | null) {
  return useQuery({
    queryKey: [...keys.account(address ?? ""), "state"],
    queryFn: ({ signal }) => getJson<AccountState>(`${API}/v1/account/${address}`, signal),
    enabled: !!address,
  });
}

export function useOrders(address: string | null) {
  return useQuery({
    queryKey: keys.orders(address ?? ""),
    queryFn: ({ signal }) => getJson<{ items: RestingOrder[] }>(`${API}/v1/orders/${address}`, signal).then(value => value.items),
    enabled: !!address,
  });
}

/** GET /v1/account/:address/activity: newest first, paged like trades, leaving out the event kinds in `exclude`. */
export function useAccountActivity(address: string | null, exclude: readonly string[] = []) {
  return useInfiniteQuery({
    queryKey: [...keys.account(address ?? ""), "activity", exclude.join(",")],
    queryFn: ({ signal, pageParam }) => getJson<ActivityPage>(
      `${INDEXER}/v1/account/${address}/activity${query(pageParam ? `cursor=${pageParam}` : "", "limit=25", exclude.length ? `exclude=${exclude.join(",")}` : "")}`, signal),
    initialPageParam: null as string | null,
    getNextPageParam: page => page.nextCursor,
    enabled: !!address,
  });
}

/** The trader's USDC balance in their own wallet (not deposited collateral). */
export function useWalletUsdc() {
  const config = useConfig(), { address, chain, settlement } = useTrader();
  const token = settlement?.tokenAddress;
  return useQuery({
    queryKey: [...keys.account(address ?? ""), "wallet-usdc", token],
    queryFn: () => {
      const reader = getPublicClient(config, { chainId: chain.id });
      if (!reader) throw new Error("No RPC for the settlement chain");
      return reader.readContract({ address: token!, abi: erc20Abi, functionName: "balanceOf", args: [address as Address] });
    },
    enabled: !!address && !!token,
  });
}

export function useProtocol() {
  return useQuery({ queryKey: [...keys.indexer, "protocol"], queryFn: ({ signal }) => getJson<Protocol>(`${INDEXER}/v1/protocol`, signal) });
}
export function useRisk() {
  return useQuery({ queryKey: [...keys.indexer, "risk"], queryFn: ({ signal }) => getJson<Risk>(`${INDEXER}/v1/risk?finalized=true`, signal) });
}
export function usePublicPositions() {
  return useQuery({ queryKey: [...keys.indexer, "positions"], queryFn: ({ signal }) => getJson<{ items: PublicPosition[]; total: number }>(`${INDEXER}/v1/positions?finalized=true&limit=100`, signal) });
}
export function useRecentTrades() {
  return useQuery({ queryKey: [...keys.indexer, "trades"], queryFn: ({ signal }) => getJson<{ items: Activity[] }>(`${INDEXER}/v1/activity?kind=TradeExecuted&finalized=true&limit=30`, signal).then(value => value.items) });
}
export function useIndexerHealth() {
  return useQuery({ queryKey: [...keys.indexer, "health"], queryFn: ({ signal }) => getJson<IndexerHealth>(`${INDEXER}/health`, signal) });
}

type IndexedEvent = { initial?: boolean; reset?: boolean; changed?: boolean; accounts?: string[] };

/** Mount once: refreshes queries when the indexer reports new blocks. */
export function useIndexerSync() {
  const client = useQueryClient();
  return useEventStream(`${INDEXER}/v1/updates/stream`, {
    indexed: data => {
      const update = data as IndexedEvent;
      if (update.initial || update.reset) { void client.invalidateQueries(); return; }
      if (update.changed) void client.invalidateQueries({ queryKey: keys.indexer });
      for (const account of update.accounts ?? []) void client.invalidateQueries({ queryKey: keys.account(account) });
    },
  });
}

/** Open orders only, optionally for one market: limit and trigger (TP/SL, stop entry) alike. */
export function useOpenOrders(address: string | null, market?: Market) {
  return useQuery({
    queryKey: keys.orders(address ?? ""),
    queryFn: ({ signal }) => getJson<{ items: RestingOrder[] }>(`${API}/v1/orders/${address}`, signal).then(value => value.items),
    enabled: !!address,
    select: items => items.filter(order => (order.status === "open" || order.status === "executing") && (!market || order.market === market)),
  });
}

type FinalityOption = { finalized?: boolean };
const finalityParam = (options?: FinalityOption) => (options?.finalized ? "finalized=true" : "");
const query = (...parts: string[]) => { const joined = parts.filter(Boolean).join("&"); return joined ? `?${joined}` : ""; };

/** GET /v1/portfolio/:address: realized PnL, fees, funding, deposits and volume replayed from indexed events. */
export function usePortfolio(address: string | null, options?: FinalityOption) {
  return useQuery({
    queryKey: [...keys.portfolio(address ?? ""), "summary", !!options?.finalized],
    queryFn: ({ signal }) => getJson<Portfolio>(`${INDEXER}/v1/portfolio/${address}${query(finalityParam(options))}`, signal),
    enabled: !!address,
  });
}

/** GET /v1/portfolio/:address/history: PnL and collateral points (per event, or the last of each hour/day). */
export function usePortfolioHistory(address: string | null, interval: PortfolioInterval = "event", options?: FinalityOption & { limit?: number }) {
  const limit = options?.limit ?? 500;
  return useQuery({
    queryKey: [...keys.portfolio(address ?? ""), "history", interval, limit, !!options?.finalized],
    queryFn: ({ signal }) => getJson<PortfolioHistory>(`${INDEXER}/v1/portfolio/${address}/history${query(`interval=${interval}`, `limit=${limit}`, finalityParam(options))}`, signal),
    enabled: !!address,
  });
}

type PageOptions = FinalityOption & { market?: Market; limit?: number };
const pageQuery = (options: PageOptions | undefined, cursor: string | null) =>
  query(cursor ? `cursor=${cursor}` : "", `limit=${options?.limit ?? 25}`, options?.market ? `market=${encodeURIComponent(options.market)}` : "", finalityParam(options));

/**
 * GET /v1/portfolio/:address/trades: fills newest first with realized PnL per
 * fill. Paged: `data.pages.flatMap(page => page.items)`, then `fetchNextPage()`
 * while `hasNextPage`.
 */
export function usePortfolioTrades(address: string | null, options?: PageOptions) {
  return useInfiniteQuery({
    queryKey: [...keys.portfolio(address ?? ""), "trades", options?.market ?? "all", options?.limit ?? 25, !!options?.finalized],
    queryFn: ({ signal, pageParam }) => getJson<FillPage>(`${INDEXER}/v1/portfolio/${address}/trades${pageQuery(options, pageParam)}`, signal),
    initialPageParam: null as string | null,
    getNextPageParam: page => page.nextCursor,
    enabled: !!address,
  });
}

/** GET /v1/funding/:address: funding payments newest first (`amount` is the PnL effect). Paged like trades. */
export function useFundingHistory(address: string | null, options?: PageOptions) {
  return useInfiniteQuery({
    queryKey: [...keys.portfolio(address ?? ""), "funding", options?.market ?? "all", options?.limit ?? 25, !!options?.finalized],
    queryFn: ({ signal, pageParam }) => getJson<FundingPage>(`${INDEXER}/v1/funding/${address}${pageQuery(options, pageParam)}`, signal),
    initialPageParam: null as string | null,
    getNextPageParam: page => page.nextCursor,
    enabled: !!address,
  });
}
