// Wire types live in packages/shared/src/api-types.ts, shared with the SDK and MCP server.
import type { Market } from "../../../../packages/shared/src/api-types.js";

export type * from "../../../../packages/shared/src/api-types.js";

/** The launch markets: the fallback list before `/v1/config` has loaded. */
export const MARKETS: readonly Market[] = ["BTC", "ETH"];

/** The symbol at a contract index; pass the live list from `useMarketList()` for markets added after launch. */
export const marketFromIndex = (
  index: number | null | undefined,
  symbols: readonly Market[] = MARKETS,
): Market | null => (index === null || index === undefined ? null : (symbols[index] ?? null));
