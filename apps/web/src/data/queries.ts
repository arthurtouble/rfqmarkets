// Server state through TanStack Query. The indexer's update stream
// (useIndexerSync) invalidates these keys instead of polling.
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useConfig } from "wagmi";
import { getPublicClient } from "wagmi/actions";
import { erc20Abi, type Address } from "viem";
import { API, INDEXER } from "../lib/env.js";
import { useEventStream } from "../lib/event-stream.js";
import { getJson } from "../lib/http.js";
import type { AccountState, Activity, IndexerHealth, Protocol, PublicPosition, RestingOrder, Risk } from "../lib/types.js";
import { useTrader } from "../wallet/trader.js";

export const keys = {
  account: (address: string) => ["account", address.toLowerCase()] as const,
  indexer: ["indexer"] as const,
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
    queryKey: [...keys.account(address ?? ""), "orders"],
    queryFn: ({ signal }) => getJson<{ items: RestingOrder[] }>(`${API}/v1/orders/${address}`, signal).then(value => value.items),
    enabled: !!address,
  });
}

export function useAccountActivity(address: string | null) {
  return useQuery({
    queryKey: [...keys.account(address ?? ""), "activity"],
    queryFn: ({ signal }) => getJson<{ items: Activity[] }>(`${INDEXER}/v1/account/${address}/activity?limit=50`, signal).then(value => value.items),
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
