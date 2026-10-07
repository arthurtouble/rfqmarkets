// Position and close math for the positions list, the close sheets and the
// portfolio. Inputs are a marked account (lib/account.ts markAccount), so the
// numbers match the live prices the rest of the app shows.
import { positionTransition } from "./account.js";
import { abs } from "./format.js";
import type { AccountState, Fill, Market, MarketState } from "./types.js";

/** A position this close to liquidation (as a share of its mark) gets a warning. */
export const NEAR_LIQUIDATION = 0.1;
/** Share presets in the close sheet, in percent. */
export const CLOSE_PRESETS = [25, 50, 75, 100] as const;

export type PositionView = {
  market: Market;
  long: boolean;
  /** Absolute size in 1e18 base units. */
  size: bigint;
  /** Absolute notional at the live price, USDC 1e6. */
  notional: bigint;
  entryPrice: bigint;
  markPrice: bigint;
  pnl: bigint;
  /** Initial margin this leg uses, USDC 1e6. */
  margin: bigint;
  /** Return on that margin as a fraction, or null without margin. */
  roe: number | null;
  /** Funding accrued since the last settlement; positive was received. */
  funding: bigint;
  liquidationPrice: bigint | null;
  /** Distance from the mark to the liquidation price, as a fraction of the mark. */
  liquidationDistance: number | null;
};

/** One open position as displayed, or null when the account is flat in `market`. */
export function positionView(account: AccountState, market: Market): PositionView | null {
  const position = account.positions[market];
  const signed = BigInt(position?.size ?? "0");
  if (signed === 0n) return null;
  const pnl = BigInt(position.unrealizedPnl), margin = BigInt(position.initialMargin ?? "0");
  const markPrice = BigInt(position.markPrice);
  const liquidationPrice = position.estimatedLiquidationPrice === null ? null : BigInt(position.estimatedLiquidationPrice);
  return {
    market, long: signed > 0n, size: abs(signed), notional: abs(BigInt(position.notional)),
    entryPrice: BigInt(position.entryPrice), markPrice, pnl, margin,
    roe: margin > 0n ? Number(pnl * 1_000_000n / margin) / 1_000_000 : null,
    funding: BigInt(position.accruedFunding),
    liquidationPrice,
    liquidationDistance: liquidationPrice !== null && markPrice > 0n ? Number(abs(markPrice - liquidationPrice) * 1_000_000n / markPrice) / 1_000_000 : null,
  };
}

/** Every open position, largest first. */
export function openPositions(account: AccountState | null | undefined): PositionView[] {
  if (!account) return [];
  return Object.keys(account.positions)
    .map(market => positionView(account, market))
    .filter((view): view is PositionView => view !== null)
    .sort((a, b) => (a.notional === b.notional ? a.market.localeCompare(b.market) : a.notional > b.notional ? -1 : 1));
}

export const isNearLiquidation = (view: PositionView) => view.liquidationDistance !== null && view.liquidationDistance < NEAR_LIQUIDATION;

export type ClosePreview = {
  /** Base units the close sells (long) or buys back (short). */
  closingSize: bigint;
  /** Size left open afterwards. */
  remainingSize: bigint;
  /** Notional of the closed share at `price`. */
  closingNotional: bigint;
  /** Price the close is estimated to fill at: the bid for a long, the ask for a short. */
  price: bigint;
  /** Realized PnL of the closed share at `price`, before fees. */
  realizedPnl: bigint;
};

/**
 * What closing `fractionBps` of the position would do at `price` (the live bid
 * for a long, ask for a short when omitted). The size rounds toward zero, as
 * the API's close quote does.
 */
export function closePreview(view: PositionView, fractionBps: number, live?: Pick<MarketState, "bid" | "ask"> | null, price?: bigint): ClosePreview {
  const fill = price ?? (live ? BigInt(view.long ? live.bid : live.ask) : view.markPrice);
  const closingSize = view.size * BigInt(fractionBps) / 10_000n;
  const signed = view.long ? view.size : -view.size;
  const { realizedPnl } = positionTransition(signed, view.entryPrice, view.long ? -closingSize : closingSize, fill);
  return {
    closingSize, remainingSize: view.size - closingSize,
    closingNotional: closingSize * fill / 10n ** 18n, price: fill, realizedPnl,
  };
}

/** Totals for closing every position at the live prices. */
export function closeAllPreview(positions: readonly PositionView[], markets: Record<Market, Pick<MarketState, "bid" | "ask"> | undefined>, fractionBps = 10_000) {
  let notional = 0n, realizedPnl = 0n;
  for (const view of positions) {
    const preview = closePreview(view, fractionBps, markets[view.market]);
    notional += preview.closingNotional;
    realizedPnl += preview.realizedPnl;
  }
  return { count: positions.length, notional, realizedPnl };
}

export type FillAction = "Open long" | "Open short" | "Add to long" | "Add to short" | "Reduce long" | "Reduce short" | "Close long" | "Close short" | "Flip to long" | "Flip to short" | "Liquidated";

/** What a fill did to the position, from its size before and after. */
export function fillAction(fill: Pick<Fill, "kind" | "sizeBefore" | "sizeAfter">): FillAction {
  if (fill.kind === "liquidation") return "Liquidated";
  const before = BigInt(fill.sizeBefore), after = BigInt(fill.sizeAfter);
  const wasLong = before > 0n, isLong = after > 0n;
  if (before === 0n) return isLong ? "Open long" : "Open short";
  if (after === 0n) return wasLong ? "Close long" : "Close short";
  if (wasLong !== isLong) return isLong ? "Flip to long" : "Flip to short";
  return abs(after) > abs(before) ? (isLong ? "Add to long" : "Add to short") : (isLong ? "Reduce long" : "Reduce short");
}

/** Whether a fill realized PnL (it reduced, closed, flipped or was liquidated). */
export const fillRealizes = (fill: Pick<Fill, "kind" | "sizeBefore" | "sizeAfter">) => {
  const action = fillAction(fill);
  return !action.startsWith("Open") && !action.startsWith("Add");
};
