import { useMemo } from "react";
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
  // Many components read the account; mark it once per price update, not once per reader render.
  const account = useMemo(
    () => (address ? markAccount(state.data ?? emptyAccount(address, snapshot), snapshot) : null),
    [address, state.data, snapshot],
  );
  if (!address) return { account: null, loading: false, error: null };
  return { account, loading: state.isPending, error: state.isError ? state.error : null };
}
