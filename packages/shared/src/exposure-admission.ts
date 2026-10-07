import { positionPnl } from "./account-risk.js";
import { marketRegistry } from "./markets.js";
import { BASE, RATE, YEAR_SECONDS, abs, high128, low128 } from "./numeric.js";

export interface ExposureMarket {
  aggregateBase: bigint;
  fundingIndex: bigint;
  fundingTime: bigint;
  lastPriceTime: bigint;
  lastBid: bigint;
  lastAsk: bigint;
  enabled: boolean;
}
export interface ExposureBook {
  longBase: bigint;
  shortBase: bigint;
  limits: bigint;
  ready: boolean;
}
export interface PositionState {
  size: bigint;
  entryPrice: bigint;
  lastFundingIndex: bigint;
}
/**
 * Funding index projected to `timestamp` with the contract's APR clamp. Callers
 * must reject `netCap === 0n` and `market.fundingTime > timestamp` first.
 */
export function projectedFundingIndex(market: ExposureMarket, netCap: bigint, timestamp: bigint) {
  const mid = (market.lastBid + market.lastAsk) / 2n;
  let apr = (((market.aggregateBase * mid) / BASE) * RATE) / netCap;
  apr = apr > RATE ? RATE : apr < -RATE ? -RATE : apr;
  const change = (mid * abs(apr) * (timestamp - market.fundingTime)) / (RATE * YEAR_SECONDS);
  return market.fundingIndex + (apr < 0n ? -change : change);
}
export function isPositionReduction(previous: bigint, delta: bigint) {
  const next = previous + delta;
  return abs(next) < abs(previous) && (next === 0n || next > 0n === previous > 0n);
}
const ceilBps = (value: bigint, shockBps: bigint) => (abs(value) * shockBps + 9_999n) / 10_000n;
/** Market `index`'s stress shock as registered on chain (`marketParams(id).shockBps`). */
export const stressShockBps = (index: number) => marketRegistry.at(index).shockBps;
/** One market's term of `RFQRiskMath.portfolioStress`: |net skew| x shock, rounded up. */
export const marketStress = (net: bigint, index: number) =>
  net === 0n ? 0n : ceilBps(net, stressShockBps(index));
/**
 * Mirrors `RFQRiskMath.portfolioStress`: the sum of |net skew| x shock over markets, each rounded up.
 * `nets[i]` is market i's net notional.
 */
export function makerStress(...nets: bigint[]) {
  let total = 0n;
  for (const [index, net] of nets.entries()) total += marketStress(net, index);
  return total;
}
/**
 * Order-independent upper envelope for maker cash that one escaped approval can
 * consume. The execution and current-entry notionals bound realized PnL; a
 * full-APR deadline charge covers the existing position and the approval's
 * full delta while the certificate remains executable.
 */
export function pendingMakerDebit(input: {
  position: PositionState;
  market: ExposureMarket;
  delta: bigint;
  executionPrice: bigint;
  timestamp: bigint;
  deadline: bigint;
  netLimit: bigint;
}) {
  const { position, market, delta, executionPrice, timestamp, deadline, netLimit } = input,
    mid = (market.lastBid + market.lastAsk) / 2n,
    cap = high128(netLimit);
  if (cap === 0n || market.fundingTime > timestamp || deadline < timestamp)
    throw new Error("invalid capital reservation policy");
  const index = projectedFundingIndex(market, cap, timestamp),
    payment = (position.size * (index - position.lastFundingIndex)) / BASE;
  const currentFundingDebit = payment < 0n ? -payment : 0n,
    quantity = abs(delta),
    executionNotional = (quantity * executionPrice) / BASE,
    entryNotional = (quantity * position.entryPrice) / BASE,
    existingNotional = (abs(position.size) * mid) / BASE;
  const seconds = deadline - timestamp,
    futureFunding = ((existingNotional + executionNotional) * seconds + YEAR_SECONDS - 1n) / YEAR_SECONDS;
  return currentFundingDebit + executionNotional + entryNotional + futureFunding;
}
/** Independent integer model of selected-market funding, realized PnL and canonical exposure bounds. */
export function exposureAdmission(input: {
  /** Every registered market, by index. */
  markets: readonly ExposureMarket[];
  books: readonly ExposureBook[];
  netLimits: readonly bigint[];
  market: number;
  position: PositionState;
  delta: bigint;
  executionPrice: bigint;
  timestamp: bigint;
  backing: bigint;
  floor: bigint;
}) {
  const { markets, books, netLimits, market, position, delta, executionPrice, timestamp, floor } = input,
    previous = position.size,
    next = previous + delta,
    reduction = isPositionReduction(previous, delta);
  const reject = (reason: string) => ({ allowed: false, reason, reduction });
  if (
    markets.length === 0 ||
    books.length !== markets.length ||
    netLimits.length !== markets.length ||
    !Number.isInteger(market) ||
    market < 0 ||
    market >= markets.length
  )
    return reject("invalid_policy");
  if (!books.every((book) => book.ready)) return reject("exposure_migration_required");
  const selected = markets[market],
    cap = high128(netLimits[market]);
  if (cap === 0n || selected.fundingTime > timestamp) return reject("invalid_policy");
  const index = projectedFundingIndex(selected, cap, timestamp),
    payment = (previous * (index - position.lastFundingIndex)) / BASE;
  let backing = input.backing + payment;
  if (backing < 0n) return reject("maker_settlement_incident");
  const closed =
      previous !== 0n && previous > 0n !== delta > 0n
        ? abs(delta) < abs(previous)
          ? abs(delta)
          : abs(previous)
        : 0n,
    pnl = positionPnl(previous < 0n ? -closed : closed, position.entryPrice, executionPrice);
  backing -= pnl;
  if (backing < 0n) return reject("maker_settlement_incident");
  if (!reduction && (!selected.enabled || backing < floor)) return reject("maker_capital_or_disabled");
  const within = (value: bigint, limit: bigint, old: bigint) => value <= limit || (reduction && value <= old),
    oldNet: bigint[] = [],
    newNet: bigint[] = [];
  for (let i = 0; i < markets.length; i++) {
    const state = markets[i],
      book = books[i];
    let longs = book.longBase,
      shorts = book.shortBase;
    if (
      longs + shorts !== 0n &&
      (state.lastPriceTime === 0n || timestamp < state.lastPriceTime || timestamp - state.lastPriceTime > 15n)
    )
      return reject("stale_gross_price");
    const mark = (state.lastBid + state.lastAsk) / 2n;
    oldNet[i] = (state.aggregateBase * mark) / BASE;
    newNet[i] = ((state.aggregateBase + (i === market ? delta : 0n)) * mark) / BASE;
    const gross = ((longs + shorts) * state.lastAsk) / BASE,
      long = (longs * state.lastAsk) / BASE,
      short = (shorts * state.lastAsk) / BASE;
    if (i === market) {
      if (previous > 0n) longs -= previous;
      else shorts -= abs(previous);
      if (next > 0n) longs += next;
      else shorts += abs(next);
    }
    if (longs < 0n || shorts < 0n) return reject("inconsistent_exposure_book");
    if (
      !within(((longs + shorts) * state.lastAsk) / BASE, low128(book.limits), gross) ||
      !within((longs * state.lastAsk) / BASE, high128(book.limits), long) ||
      !within((shorts * state.lastAsk) / BASE, high128(book.limits), short)
    )
      return reject("gross_or_side_cap");
    if (!within(abs(newNet[i]), high128(netLimits[i]), abs(oldNet[i]))) return reject("net_cap");
  }
  if (!within(makerStress(...newNet), backing / 4n, makerStress(...oldNet))) return reject("maker_stress");
  return { allowed: true, reason: "allowed", reduction };
}
