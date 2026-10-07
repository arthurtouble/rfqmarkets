// Re-marks an account between indexer updates using the live price stream.
// Mirrors GET /v1/account in services/api (accountView) so numbers do not jump
// on refresh: every leg's margin tiers are scaled by its market's
// marginScaleBps, as RFQRiskMath.accountMargin does.
import { openingPnl, positionPnl } from "../../../../packages/shared/src/account-risk.js";
import { abs } from "./format.js";
import { DEFAULT_MARGIN_SCALE_BPS, legMargin } from "./leverage.js";
import { MARKETS, type AccountPosition, type AccountState, type Market, type MarketSnapshot } from "./types.js";

const BASE = 10n ** 18n;
/** Bisection steps for the liquidation-price estimate (as the API). */
const LIQUIDATION_SEARCH_STEPS = 80;
/** Short liquidation prices are searched up to this multiple of the current mid. */
const SHORT_SEARCH_CEILING = 20n;

/** Margin multipliers by market, for markets the snapshot does not carry them for. */
export type MarginScales = Partial<Record<Market, number>>;

/** A market's margin multiplier: live snapshot, then the account read, then `scales`, then 1x. */
export function marginScaleOf(market: Market, snapshot?: MarketSnapshot | null, state?: AccountState | null, scales?: MarginScales): number {
  return snapshot?.markets[market]?.marginScaleBps
    ?? state?.marginParameters?.[market]?.marginScaleBps
    ?? scales?.[market]
    ?? DEFAULT_MARGIN_SCALE_BPS;
}

/** The markets an account view should cover: every priced market plus any held position. */
function marketsOf(state: AccountState | null, snapshot: MarketSnapshot | null): Market[] {
  const names = new Set<Market>(snapshot ? Object.keys(snapshot.markets) : MARKETS);
  for (const name of Object.keys(state?.positions ?? {})) names.add(name);
  return [...names];
}

const flat = (market: Market, snapshot: MarketSnapshot | null): AccountPosition => ({
  size: "0", entryPrice: "0", markPrice: snapshot?.markets[market]?.mid ?? "0", notional: "0",
  unrealizedPnl: "0", accruedFunding: "0", lastFundingIndex: "0", estimatedLiquidationPrice: null,
});

export function emptyAccount(account: string, snapshot: MarketSnapshot | null): AccountState {
  const position = (market: Market) => flat(market, snapshot);
  return {
    account, blockNumber: snapshot?.blockNumber ?? 0, collateral: "0", equity: "0", openingEquity: "0",
    unrealizedPnl: "0", accruedFunding: "0", grossNotional: "0", initialMargin: "0", maintenanceMargin: "0",
    availableMargin: "0", maintenanceBuffer: "0", marginRatioBps: null, effectiveLeverageBps: null,
    liquidatable: false, positions: Object.fromEntries(marketsOf(null, snapshot).map(market => [market, position(market)])),
  };
}

/** One position with the prices it is marked at, for health and liquidation math. */
export type RiskLeg = { market: Market; size: bigint; entryPrice: bigint; bid: bigint; ask: bigint; mid: bigint; scaleBps: number };

/** Legs at live prices; a market without a live price is marked at its last known mark. */
function legsOf(state: AccountState, snapshot: MarketSnapshot | null, scales?: MarginScales): RiskLeg[] {
  const legs: RiskLeg[] = [];
  for (const market of marketsOf(state, snapshot)) {
    const position = state.positions[market], live = snapshot?.markets[market];
    const fallback = BigInt(position?.markPrice ?? live?.mid ?? "0");
    legs.push({
      market, size: BigInt(position?.size ?? "0"), entryPrice: BigInt(position?.entryPrice ?? "0"),
      bid: live ? BigInt(live.bid) : fallback, ask: live ? BigInt(live.ask) : fallback, mid: live ? BigInt(live.mid) : fallback,
      scaleBps: marginScaleOf(market, snapshot, state, scales),
    });
  }
  return legs;
}

/** Maintenance health (equity minus maintenance margin) with `selected` moved to `candidateMid`. */
function healthAt(base: bigint, legs: readonly RiskLeg[], selected: Market, candidateMid: bigint) {
  let value = base, required = 0n;
  for (const leg of legs) {
    if (leg.size === 0n) continue;
    const move = (price: bigint) => (leg.market === selected && leg.mid > 0n ? candidateMid * price / leg.mid : price);
    const bid = move(leg.bid), ask = move(leg.ask);
    value += positionPnl(leg.size, leg.entryPrice, leg.size > 0n ? bid : ask);
    required += legMargin(abs(leg.size) * ask / BASE, false, leg.scaleBps);
  }
  return value - required;
}

/**
 * The mid at which `selected` makes the account liquidatable, holding the
 * other markets still (cross margin), or null when no price in range does.
 * `base` is collateral plus accrued funding. Mirrors accountView in services/api.
 */
export function liquidationPrice(base: bigint, legs: readonly RiskLeg[], selected: Market): bigint | null {
  const leg = legs.find(item => item.market === selected);
  if (!leg || leg.size === 0n || leg.mid <= 0n) return null;
  const currentMid = leg.mid;
  if (healthAt(base, legs, selected, currentMid) <= 0n) return currentMid;
  // Longs lose health as price falls, shorts as it rises. Bisect to the healthy side of the boundary.
  let low = leg.size > 0n ? 1n : currentMid, high = leg.size > 0n ? currentMid : currentMid * SHORT_SEARCH_CEILING;
  if (healthAt(base, legs, selected, leg.size > 0n ? low : high) > 0n) return null;
  for (let step = 0; step < LIQUIDATION_SEARCH_STEPS; step++) {
    const middle = (low + high) / 2n, healthy = healthAt(base, legs, selected, middle) > 0n;
    if (leg.size > 0n === healthy) high = middle;
    else low = middle;
  }
  return high;
}

export function markAccount(state: AccountState, snapshot: MarketSnapshot | null, scales?: MarginScales): AccountState {
  if (!snapshot) return state;
  let unrealized = 0n, funding = 0n, gross = 0n, initial = 0n, maintenance = 0n;
  const pnls: bigint[] = [], positions = { ...state.positions }, legs = legsOf(state, snapshot, scales);
  for (const leg of legs) {
    const position = state.positions[leg.market] ?? flat(leg.market, snapshot);
    const live = snapshot.markets[leg.market];
    const mark = leg.size >= 0n ? leg.bid : leg.ask;
    const notional = abs(leg.size) * leg.ask / BASE;
    const pnl = positionPnl(leg.size, leg.entryPrice, mark);
    const accrued = live ? -leg.size * (BigInt(live.projectedFundingIndex) - BigInt(position.lastFundingIndex)) / BASE : BigInt(position.accruedFunding);
    const legInitial = legMargin(notional, true, leg.scaleBps), legMaintenance = legMargin(notional, false, leg.scaleBps);
    pnls.push(pnl);
    unrealized += pnl; funding += accrued; gross += notional;
    initial += legInitial; maintenance += legMaintenance;
    positions[leg.market] = {
      ...position, markPrice: mark.toString(), notional: notional.toString(), unrealizedPnl: pnl.toString(), accruedFunding: accrued.toString(),
      initialMargin: legInitial.toString(), maintenanceMargin: legMaintenance.toString(),
    };
  }
  const collateral = BigInt(state.collateral);
  const equity = collateral + unrealized + funding;
  const opening = collateral + funding + openingPnl(pnls);
  for (const leg of legs) {
    const liquidation = liquidationPrice(collateral + funding, legs, leg.market);
    positions[leg.market] = { ...positions[leg.market], estimatedLiquidationPrice: liquidation?.toString() ?? null };
  }
  return {
    ...state, blockNumber: snapshot.blockNumber, positions,
    unrealizedPnl: unrealized.toString(), accruedFunding: funding.toString(), grossNotional: gross.toString(),
    equity: equity.toString(), openingEquity: opening.toString(),
    initialMargin: initial.toString(), maintenanceMargin: maintenance.toString(),
    availableMargin: (opening - initial).toString(), maintenanceBuffer: (equity - maintenance).toString(),
    marginRatioBps: equity > 0n ? (maintenance * 10_000n / equity).toString() : null,
    effectiveLeverageBps: equity > 0n ? (gross * 10_000n / equity).toString() : null,
    liquidatable: equity < maintenance,
  };
}

export const hasPosition = (state: AccountState, market: Market) => BigInt(state.positions[market]?.size ?? "0") !== 0n;

/** Open positions' markets, in the order the account lists them. */
export const openMarkets = (state: AccountState | null | undefined): Market[] =>
  state ? Object.keys(state.positions).filter(market => hasPosition(state, market)) : [];

/**
 * Initial margin the account would need after trading `notional` USDC in
 * `market` (positive buys, negative sells), using the live ask as the mark.
 */
export function initialMarginAfter(state: AccountState, snapshot: MarketSnapshot, market: Market, notionalDelta: bigint, scales?: MarginScales): bigint {
  let total = 0n;
  for (const name of marketsOf(state, snapshot)) {
    const live = snapshot.markets[name];
    const ask = BigInt(live?.ask ?? state.positions[name]?.markPrice ?? "0");
    if (ask === 0n) continue;
    let size = BigInt(state.positions[name]?.size ?? "0");
    if (name === market) size += notionalDelta * BASE / ask;
    const notional = abs(size) * ask / BASE;
    total += legMargin(notional, true, marginScaleOf(name, snapshot, state, scales));
  }
  return total;
}

/** RFQRiskMath.positionTransition: next size, entry price and realized PnL (as the indexer replays it). */
export function positionTransition(oldSize: bigint, oldEntry: bigint, delta: bigint, price: bigint) {
  const nextSize = oldSize + delta;
  if (oldSize === 0n || oldSize > 0n === delta > 0n) {
    const combined = abs(nextSize);
    return { nextSize, nextEntry: combined === 0n ? 0n : (abs(oldSize) * oldEntry + abs(delta) * price) / combined, realizedPnl: 0n };
  }
  const closed = abs(delta) < abs(oldSize) ? abs(delta) : abs(oldSize);
  const realizedPnl = oldSize > 0n ? closed * price / BASE - closed * oldEntry / BASE : closed * oldEntry / BASE - closed * price / BASE;
  const nextEntry = nextSize === 0n ? 0n : nextSize > 0n !== oldSize > 0n ? price : oldEntry;
  return { nextSize, nextEntry, realizedPnl };
}

/**
 * Estimated liquidation mid of `market` after trading `notionalDelta` USDC
 * (positive buys at the ask, negative sells at the bid; 0 for the current
 * position), using each market's scaled margin tiers. Fees are ignored. Null
 * when the resulting position is flat or no price in range liquidates it.
 */
export function estimateLiquidationPrice(state: AccountState, snapshot: MarketSnapshot, market: Market, notionalDelta = 0n, scales?: MarginScales): bigint | null {
  const legs = legsOf(state, snapshot, scales);
  let base = BigInt(state.collateral);
  for (const leg of legs) {
    const live = snapshot.markets[leg.market], position = state.positions[leg.market];
    if (live && position) base += -leg.size * (BigInt(live.projectedFundingIndex) - BigInt(position.lastFundingIndex)) / BASE;
    else if (position) base += BigInt(position.accruedFunding);
  }
  let leg = legs.find(item => item.market === market);
  if (!leg) {
    const live = snapshot.markets[market];
    if (!live) return null;
    leg = { market, size: 0n, entryPrice: 0n, bid: BigInt(live.bid), ask: BigInt(live.ask), mid: BigInt(live.mid), scaleBps: marginScaleOf(market, snapshot, state, scales) };
    legs.push(leg);
  }
  if (notionalDelta !== 0n) {
    const price = notionalDelta > 0n ? leg.ask : leg.bid;
    if (price <= 0n) return null;
    const next = positionTransition(leg.size, leg.entryPrice, notionalDelta * BASE / price, price);
    base += next.realizedPnl;
    leg.size = next.nextSize; leg.entryPrice = next.nextEntry;
  }
  return liquidationPrice(base, legs, market);
}
