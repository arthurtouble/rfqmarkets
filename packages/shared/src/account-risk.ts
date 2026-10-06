import { BASE, abs } from "./numeric.js";

/** Match RFQRiskMath's separate-leg integer rounding, including shorts. */
export function positionPnl(size: bigint, entry: bigint, mark: bigint) {
  const quantity = abs(size);
  return size >= 0n
    ? (quantity * mark) / BASE - (quantity * entry) / BASE
    : (quantity * entry) / BASE - (quantity * mark) / BASE;
}

/** Positive PnL never offsets a different position's opening-margin loss. */
export function openingPnl(values: bigint[]) {
  return values.reduce((sum, value) => sum + (value < 0n ? value : 0n), 0n);
}
