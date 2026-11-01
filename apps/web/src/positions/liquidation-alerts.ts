import { useEffect, useRef } from "react";
import { useMarketList } from "../data/markets.js";
import { useAccountActivity } from "../data/queries.js";
import { usdc } from "../lib/format.js";
import { useToasts } from "../ui/toasts.js";
import { useTrader } from "../wallet/trader.js";

/** Only Liquidated rows matter here: leave every other kind the indexer records out of the response. */
const NOT_LIQUIDATIONS = [
  "Deposited",
  "Withdrawn",
  "MarginTransferred",
  "NonceCancelled",
  "SessionGranted",
  "SessionRevoked",
  "TradeExecuted",
  "FundingSettled",
  "PositionClosed",
  "DeficitAbsorbed",
  "MakerWithdrawn",
  "EpochAdvanced",
  "ResolutionStarted",
  "ResolutionPriceReady",
  "ResolutionFinalized",
];

/**
 * Toasts when the venue liquidates one of the trader's positions while the app is open (the account or a Home
 * trade's isolated account). Without it the position just disappears. Liquidations already in the history when
 * the page loads stay quiet.
 */
export function useLiquidationAlerts() {
  const { address } = useTrader(),
    { notify } = useToasts(),
    markets = useMarketList();
  const activity = useAccountActivity(address, NOT_LIQUIDATIONS);
  const seen = useRef<Set<string> | null>(null);
  useEffect(() => {
    seen.current = null;
  }, [address]);
  const items = activity.data?.pages[0]?.items;
  useEffect(() => {
    if (!items) return;
    const liquidations = items.filter((item) => item.kind === "Liquidated");
    const previous = seen.current;
    seen.current = new Set([
      ...(previous ?? []),
      ...liquidations.map((item) => `${item.tx_hash}:${item.log_index}`),
    ]);
    if (!previous) return;
    for (const item of liquidations) {
      if (previous.has(`${item.tx_hash}:${item.log_index}`)) continue;
      const market = markets.marketFromIndex(item.market) ?? "A",
        penalty = (item.payload as { penalty?: string }).penalty;
      notify({
        kind: "error",
        title: `${market} position liquidated`,
        detail: `Your margin fell below the maintenance level, so the venue closed it${penalty && penalty !== "0" ? ` (penalty ${usdc(penalty)})` : ""}. What is left stays in your account.`,
        txHash: item.tx_hash,
      });
    }
  }, [items, markets, notify]);
}
