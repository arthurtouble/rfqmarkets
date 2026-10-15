// One-tap limits for a key granted now, sized to the markets the live feed carries.
import { useMemo } from "react";
import { quickLimits, type QuickLimits } from "../wallet/quick-session.js";
import { useMarketFeed } from "./market-feed.js";

export function useQuickLimits(): QuickLimits {
  const { snapshot } = useMarketFeed();
  const caps = snapshot
    ? Object.values(snapshot.markets)
        .map((market) => market.maxTradeNotional)
        .join(",")
    : "";
  return useMemo(() => quickLimits(caps ? caps.split(",").map(BigInt) : []), [caps]);
}
