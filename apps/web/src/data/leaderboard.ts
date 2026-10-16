// Leaderboard and points from the indexer. Both read included (not yet finalized) blocks so a trade
// shows up on the board within a block; the indexer stream refreshes them through the shared keys.
import { useQuery } from "@tanstack/react-query";
import { INDEXER } from "../lib/env.js";
import { getJson } from "../lib/http.js";
import type { Leaderboard, LeaderboardSort, LeaderboardWindow, Points } from "../lib/types.js";
import { keys } from "./queries.js";

export const LEADERBOARD_SIZE = 50;

/** GET /v1/leaderboard: the top traders over a window, by volume or by net PnL. */
export function useLeaderboard(window: LeaderboardWindow, sort: LeaderboardSort) {
  return useQuery({
    queryKey: [...keys.indexer, "leaderboard", window, sort],
    queryFn: ({ signal }) =>
      getJson<Leaderboard>(
        `${INDEXER}/v1/leaderboard?window=${window}&sort=${sort}&limit=${LEADERBOARD_SIZE}`,
        signal,
      ),
    placeholderData: (previous) => previous,
  });
}

/** GET /v1/points/:address: weekly points of a wallet and its isolated (Home) accounts. */
export function usePoints(address: string | null) {
  return useQuery({
    queryKey: [...keys.account(address ?? ""), "points"],
    queryFn: ({ signal }) => getJson<Points>(`${INDEXER}/v1/points/${address}`, signal),
    enabled: !!address,
  });
}
