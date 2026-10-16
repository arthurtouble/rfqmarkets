import { useMemo } from "react";
import { useQueries, type UseQueryResult } from "@tanstack/react-query";
import { useMarketFeed } from "../data/market-feed.js";
import { useMarketList } from "../data/markets.js";
import { accountStateQuery, useAccountState, usePortfolio } from "../data/queries.js";
import { markAccount } from "../lib/account.js";
import { homeTotals, idleIsolated, isolatedAccountOf, type IdleMargin } from "../lib/isolated.js";
import type { AccountState, Market } from "../lib/types.js";
import { useTrader } from "../wallet/trader.js";

/**
 * The connected account marked to the live prices. `account` stays null until the first successful read (and
 * with no wallet), so no screen shows a $0 balance, or offers to add funds, before the balance is known:
 * render a placeholder while `loading`, and the error when `error` is set.
 */
export function useAccount(): { account: AccountState | null; loading: boolean; error: Error | null } {
  const { snapshot } = useMarketFeed();
  const { address } = useTrader();
  const state = useAccountState(address);
  // Many components read the account; mark it once per price update, not once per reader render.
  const account = useMemo(
    () => (address && state.data ? markAccount(state.data, snapshot) : null),
    [address, state.data, snapshot],
  );
  if (!address) return { account: null, loading: false, error: null };
  return { account, loading: state.isPending, error: state.isError ? state.error : null };
}

/**
 * The connected account's isolated account in `market` (where Home trades hold their own margin), marked to the
 * live prices; null with no wallet or before the market list names the market's index. `loading` holds until
 * the first read answers, so Home does not offer a new trade over one it has not seen yet.
 */
export function useIsolatedAccount(market: Market): { account: AccountState | null; loading: boolean } {
  const { snapshot } = useMarketFeed();
  const { address } = useTrader();
  const index = useMarketList().get(market)?.index;
  const isolated = address && index !== undefined ? isolatedAccountOf(address, index) : null;
  const state = useAccountState(isolated);
  const account = useMemo(
    () => (isolated && state.data ? markAccount(state.data, snapshot) : null),
    [isolated, state.data, snapshot],
  );
  return { account, loading: !!address && (index === undefined || (state.isPending && !state.isError)) };
}

type IsolatedReads = { states: Array<AccountState | undefined>; pending: boolean };
/** Hoisted so useQueries keeps its combined result between renders (an inline combine re-runs every render). */
const combineIsolated = (results: UseQueryResult<AccountState>[]): IsolatedReads => ({
  states: results.map((result) => result.data),
  pending: results.some((result) => result.isPending),
});

/**
 * The connected trader's isolated accounts (where Home trades hold their own margin), marked to the live
 * prices, and whether they are all read. The indexer names the isolated accounts the trader has moved margin
 * into; `ready` is false until it has answered and each of those accounts has been read once.
 */
export function useIsolatedAccountsState(): { accounts: AccountState[]; ready: boolean } {
  const { snapshot } = useMarketFeed();
  const { address } = useTrader();
  const portfolio = usePortfolio(address);
  const addresses = portfolio.data?.accounts;
  const queries = useMemo(
    () => (addresses ?? []).slice(1).map((account) => accountStateQuery(account)),
    [addresses],
  );
  const { states, pending } = useQueries({ queries, combine: combineIsolated });
  const accounts = useMemo(
    () =>
      states.filter((state): state is AccountState => !!state).map((state) => markAccount(state, snapshot)),
    [states, snapshot],
  );
  return { accounts, ready: !address || (!portfolio.isPending && !pending) };
}

export const useIsolatedAccounts = (): AccountState[] => useIsolatedAccountsState().accounts;

/**
 * What the trader's account is worth: the balance's equity plus every Home trade's (Portfolio's "Account
 * value"). The header and Home show this same number, so they always agree with Portfolio. Null until both the
 * account and its isolated accounts have been read.
 */
export function useAccountValue(): { value: bigint | null; homeEquity: bigint; loading: boolean } {
  const { account, loading } = useAccount();
  const isolated = useIsolatedAccountsState();
  const home = homeTotals(isolated.accounts);
  const ready = !!account && isolated.ready;
  return {
    value: ready ? BigInt(account.equity) + home.equity : null,
    homeEquity: home.equity,
    loading: loading || (!!account && !isolated.ready),
  };
}

/** Isolated accounts holding money with no open position (a Home trade that did not go through), by market. */
export function useIdleMargin(): IdleMargin<Market>[] {
  const { address } = useTrader();
  const { markets } = useMarketList();
  const { accounts } = useIsolatedAccountsState();
  return useMemo(() => {
    if (!address) return [];
    const byAccount = new Map(
      markets.map((market) => [isolatedAccountOf(address, market.index).toLowerCase(), market.symbol]),
    );
    return idleIsolated(accounts, (account) => byAccount.get(account.toLowerCase()) ?? null);
  }, [address, markets, accounts]);
}
