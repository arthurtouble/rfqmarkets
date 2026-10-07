// Re-marks an account between indexer updates using the live price stream.
// Mirrors GET /v1/account in services/api so numbers do not jump on refresh.
import { marginRate } from "../../../../packages/shared/src/pricing.js";
import { openingPnl, positionPnl } from "../../../../packages/shared/src/account-risk.js";
import { abs } from "./format.js";
import { MARKETS, type AccountPosition, type AccountState, type Market, type MarketSnapshot } from "./types.js";

const BASE = 10n ** 18n;

export function emptyAccount(account: string, snapshot: MarketSnapshot | null): AccountState {
  const position = (market: Market): AccountPosition => ({
    size: "0", entryPrice: "0", markPrice: snapshot?.markets[market].mid ?? "0", notional: "0",
    unrealizedPnl: "0", accruedFunding: "0", lastFundingIndex: "0", estimatedLiquidationPrice: null,
  });
  return {
    account, blockNumber: snapshot?.blockNumber ?? 0, collateral: "0", equity: "0", openingEquity: "0",
    unrealizedPnl: "0", accruedFunding: "0", grossNotional: "0", initialMargin: "0", maintenanceMargin: "0",
    availableMargin: "0", maintenanceBuffer: "0", marginRatioBps: null, effectiveLeverageBps: null,
    liquidatable: false, positions: { BTC: position("BTC"), ETH: position("ETH") },
  };
}

export function markAccount(state: AccountState, snapshot: MarketSnapshot | null): AccountState {
  if (!snapshot) return state;
  let unrealized = 0n, funding = 0n, gross = 0n, initial = 0n, maintenance = 0n;
  const pnls: bigint[] = [], positions = { ...state.positions };
  for (const market of MARKETS) {
    const position = state.positions[market], live = snapshot.markets[market];
    const size = BigInt(position.size), ask = BigInt(live.ask);
    const mark = size >= 0n ? BigInt(live.bid) : ask;
    const notional = abs(size) * ask / BASE;
    const pnl = positionPnl(size, BigInt(position.entryPrice), mark);
    const accrued = -size * (BigInt(live.projectedFundingIndex) - BigInt(position.lastFundingIndex)) / BASE;
    pnls.push(pnl);
    unrealized += pnl; funding += accrued; gross += notional;
    initial += notional * marginRate(notional, true) / 10_000n;
    maintenance += notional * marginRate(notional, false) / 10_000n;
    positions[market] = { ...position, markPrice: mark.toString(), notional: notional.toString(), unrealizedPnl: pnl.toString(), accruedFunding: accrued.toString() };
  }
  const collateral = BigInt(state.collateral);
  const equity = collateral + unrealized + funding;
  const opening = collateral + funding + openingPnl(pnls);
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

export const hasPosition = (state: AccountState, market: Market) => BigInt(state.positions[market].size) !== 0n;

/**
 * Initial margin the account would need after trading `notional` USDC in
 * `market` (positive buys, negative sells), using the live ask as the mark.
 */
export function initialMarginAfter(state: AccountState, snapshot: MarketSnapshot, market: Market, notionalDelta: bigint): bigint {
  let total = 0n;
  for (const name of MARKETS) {
    const ask = BigInt(snapshot.markets[name].ask);
    let size = BigInt(state.positions[name].size);
    if (name === market) size += notionalDelta * BASE / ask;
    const notional = abs(size) * ask / BASE;
    total += notional * marginRate(notional, true) / 10_000n;
  }
  return total;
}
