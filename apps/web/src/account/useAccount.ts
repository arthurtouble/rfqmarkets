import { useMemo } from "react";
import { useQueries } from "@tanstack/react-query";
import { useMarketFeed } from "../data/market-feed.js";
import { useMarketList } from "../data/markets.js";
import { accountStateQuery, useAccountState, usePortfolio } from "../data/queries.js";
import { emptyAccount, markAccount } from "../lib/account.js";
import { isolatedAccountOf } from "../lib/isolated.js";
import type { AccountState, Market } from "../lib/types.js";
import { useTrader } from "../wallet/trader.js";

/** The connected account marked to the live prices, or null when no wallet is connected. */
export function useAccount(): { account: AccountState | null; loading: boolean; error: Error | null } {
  const { snapshot } = useMarketFeed();
  const { address } = useTrader();
  const state = useAccountState(address);
  // Many components read the account; mark it once per price update, not once per reader render.
  const account = useMemo(
    () => (address ? markAccount(state.data ?? emptyAccount(address, snapshot), snapshot) : null),
    [address, state.data, snapshot],
  );
  if (!address) return { account: null, loading: false, error: null };
  return { account, loading: state.isPending, error: state.isError ? state.error : null };
}

/**
 * The connected account's isolated account in `market` (where Home trades hold their own margin), marked to the
 * live prices; null with no wallet or before the market list names the market's index.
 */
export function useIsolatedAccount(market: Market): AccountState | null {
  const { snapshot } = useMarketFeed();
  const { address } = useTrader();
  const index = useMarketList().get(market)?.index;
  const isolated = address && index !== undefined ? isolatedAccountOf(address, index) : null;
  const state = useAccountState(isolated);
  return useMemo(
    () => (isolated && state.data ? markAccount(state.data, snapshot) : null),
    [isolated, state.data, snapshot],
  );
}

/**
 * The connected trader's isolated accounts (where Home trades hold their own margin), marked to the live prices.
 * The indexer names the isolated accounts the trader has moved margin into.
 */
export function useIsolatedAccounts(): AccountState[] {
  const { snapshot } = useMarketFeed();
  const { address } = useTrader();
  const accounts = usePortfolio(address).data?.accounts?.slice(1) ?? [];
  const states = useQueries({
    queries: accounts.map((account) => accountStateQuery(account)),
    combine: (results) => results.map((result) => result.data),
  });
  return useMemo(
    () =>
      states.filter((state): state is AccountState => !!state).map((state) => markAccount(state, snapshot)),
    [states, snapshot],
  );
}
