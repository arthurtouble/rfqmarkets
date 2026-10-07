import { useMarketFeed } from "../data/market-feed.js";
import { useAccountState } from "../data/queries.js";
import { emptyAccount, markAccount } from "../lib/account.js";
import type { AccountState } from "../lib/types.js";
import { useTrader } from "../wallet/trader.js";

/** The connected account marked to the live prices, or null when no wallet is connected. */
export function useAccount(): { account: AccountState | null; loading: boolean; error: Error | null } {
  const { snapshot } = useMarketFeed();
  const { address } = useTrader();
  const state = useAccountState(address);
  if (!address) return { account: null, loading: false, error: null };
  return {
    account: markAccount(state.data ?? emptyAccount(address, snapshot), snapshot),
    loading: state.isPending,
    error: state.isError ? state.error : null,
  };
}
