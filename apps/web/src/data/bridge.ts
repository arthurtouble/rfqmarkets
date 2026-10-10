// Data for deposits from other networks: the wallet's assets (LI.FI's balance
// index), one asset's live balance on its own network, LI.FI routes, and the
// progress of a route that has been sent. Pure logic lives in lib/bridge.ts.
import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { erc20Abi, type Address } from "viem";
import { useConfig } from "wagmi";
import { getPublicClient } from "wagmi/actions";
import {
  balancesUrl, bridgeStatus, checkRoute, holdingsFrom, isNative, lifiGet, quoteUrl, statusUrl,
  type LifiQuote, type RouteRequest,
} from "../lib/bridge.js";
import { useTrader } from "../wallet/trader.js";

/** The value, once it has stopped changing for `ms`. */
export function useDebounced<T>(value: T, ms: number) {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return settled;
}

/** What the wallet holds on supported networks. LI.FI allows few balance reads, so this is cached. */
export function useHoldings(enabled: boolean) {
  const { address, settlement } = useTrader();
  const usdc = settlement?.tokenAddress;
  return useQuery({
    queryKey: ["lifi", "holdings", address],
    queryFn: async ({ signal }) => holdingsFrom(await lifiGet(balancesUrl(address!), signal), usdc!),
    enabled: enabled && !!address && !!usdc,
    staleTime: 60_000,
    retry: false,
    refetchOnWindowFocus: false,
  });
}

/** The wallet's balance of one asset on its own network, read from that network's public RPC. */
export function useSourceBalance(chainId: number | null, token: Address | null) {
  const config = useConfig(), { address } = useTrader();
  return useQuery({
    queryKey: ["source-balance", address, chainId, token],
    queryFn: () => {
      const reader = getPublicClient(config, { chainId: chainId! });
      if (!reader) throw new Error("No RPC for that network");
      return isNative(token!)
        ? reader.getBalance({ address: address! })
        : reader.readContract({ address: token!, abi: erc20Abi, functionName: "balanceOf", args: [address!] });
    },
    enabled: !!address && chainId !== null && token !== null,
    staleTime: 15_000,
  });
}

/** A checked LI.FI route for the request. Quotes are rate limited, so they refresh only when asked. */
export function useRoute(request: RouteRequest | null, decimals: number) {
  return useQuery({
    queryKey: ["lifi", "route", request && { ...request, fromAmount: request.fromAmount.toString() }],
    queryFn: async ({ signal }) => checkRoute(await lifiGet<LifiQuote>(quoteUrl(request!), signal), request!, decimals),
    enabled: request !== null,
    staleTime: 30_000,
    gcTime: 60_000,
    retry: false,
    refetchOnWindowFocus: false,
  });
}

/** A route sent from its source network and not yet delivered. Kept across reloads. */
export type SentRoute = {
  account: string;
  hash: string;
  fromChain: number;
  network: string;
  /** What was sent, e.g. "0.05 ETH". */
  sent: string;
  toAmount: string;
  durationSeconds: number;
  sentAtMs: number;
};

const STORAGE_KEY = "rfq:bridge";
export function loadSentRoute(account: string | null): SentRoute | null {
  if (!account) return null;
  try {
    const value = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null") as SentRoute | null;
    return value && value.account.toLowerCase() === account.toLowerCase() ? value : null;
  } catch {
    return null;
  }
}
export function saveSentRoute(value: SentRoute | null) {
  try {
    if (value) localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* storage unavailable: tracking still runs for this tab */
  }
}

/** LI.FI's view of a sent route, polled until it settles. */
export function useRouteStatus(route: SentRoute | null) {
  const { settlement } = useTrader();
  const usdc = settlement?.tokenAddress;
  return useQuery({
    queryKey: ["lifi", "status", route?.hash],
    queryFn: async ({ signal }) => bridgeStatus(await lifiGet(statusUrl(route!.hash, route!.fromChain), signal), usdc!),
    enabled: !!route && !!usdc,
    refetchInterval: query => (query.state.data && query.state.data.state !== "pending" ? false : 10_000),
    retry: 3,
  });
}
