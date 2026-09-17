import { openingPnl, positionPnl } from "../../../packages/shared/src/account-risk.js";
import { marginRate } from "../../../packages/shared/src/pricing.js";
import type { AccountState, Market, MarketSnapshot } from "./types.js";

const abs = (value: bigint) => value < 0n ? -value : value;

export function markAccount(state: AccountState, snapshot: MarketSnapshot | null): AccountState {
  if (!snapshot) return state;

  let unrealized = 0n;
  let negativePnl = 0n;
  let funding = 0n;
  let gross = 0n;
  let initial = 0n;
  let maintenance = 0n;
  const positions = { ...state.positions };

  for (const market of ["BTC", "ETH"] as Market[]) {
    const position = state.positions[market];
    const size = BigInt(position.size);
    const live = snapshot.markets[market];
    const mark = size >= 0n ? BigInt(live.bid) : BigInt(live.ask);
    const notional = abs(size) * BigInt(live.ask) / 10n ** 18n;
    const pnl = positionPnl(size, BigInt(position.entryPrice), mark);
    const accrued = -size * (BigInt(live.projectedFundingIndex) - BigInt(position.lastFundingIndex)) / 10n ** 18n;
    unrealized += pnl;
    negativePnl += openingPnl([pnl]);
    funding += accrued;
    gross += notional;
    initial += notional * marginRate(notional, true) / 10_000n;
    maintenance += notional * marginRate(notional, false) / 10_000n;
    positions[market] = {
      ...position,
      markPrice: mark.toString(),
      notional: notional.toString(),
      unrealizedPnl: pnl.toString(),
      accruedFunding: accrued.toString(),
    };
  }

  const collateral = BigInt(state.collateral);
  const equity = collateral + unrealized + funding;
  const openingEquity = collateral + funding + negativePnl;
  return {
    ...state,
    blockNumber: snapshot.blockNumber,
    positions,
    unrealizedPnl: unrealized.toString(),
    accruedFunding: funding.toString(),
    grossNotional: gross.toString(),
    equity: equity.toString(),
    openingEquity: openingEquity.toString(),
    initialMargin: initial.toString(),
    maintenanceMargin: maintenance.toString(),
    availableMargin: (openingEquity - initial).toString(),
    maintenanceBuffer: (equity - maintenance).toString(),
    marginRatioBps: equity > 0n ? (maintenance * 10_000n / equity).toString() : null,
    effectiveLeverageBps: equity > 0n ? (gross * 10_000n / equity).toString() : null,
    liquidatable: equity < maintenance,
  };
}
