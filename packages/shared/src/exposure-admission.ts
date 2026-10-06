import { positionPnl } from "./account-risk.js";
const BASE = 10n ** 18n,
  RATE = 10n ** 12n,
  MASK = (1n << 128n) - 1n,
  YEAR = 365n * 86400n;
const abs = (value: bigint) => (value < 0n ? -value : value);
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
export function isPositionReduction(previous: bigint, delta: bigint) {
  const next = previous + delta;
  return abs(next) < abs(previous) && (next === 0n || next > 0n === previous > 0n);
}
const floor100 = (value: bigint) => value / 100n - (value < 0n && value % 100n !== 0n ? 1n : 0n);
export function makerStress(btc: bigint, eth: bigint) {
  let result = 0n;
  for (const [b, e] of [
    [20n, 25n],
    [-20n, -25n],
    [15n, -20n],
    [-15n, 20n],
    [40n, 50n],
    [-40n, -50n],
  ]) {
    const loss = floor100(btc * b) + floor100(eth * e);
    if (loss > result) result = loss;
  }
  return result;
}
/**
 * Order-independent upper envelope for maker cash that one escaped approval can
 * consume. The execution and current-entry notionals bound realized PnL; a
 * full-APR deadline charge covers the existing position and the approval's
 * full delta while the certificate remains executable.
 */
export function pendingMakerDebit(input: {
  position: { size: bigint; entryPrice: bigint; lastFundingIndex: bigint };
  market: ExposureMarket;
  delta: bigint;
  executionPrice: bigint;
  timestamp: bigint;
  deadline: bigint;
  netLimit: bigint;
}) {
  const { position, market, delta, executionPrice, timestamp, deadline, netLimit } = input,
    mid = (market.lastBid + market.lastAsk) / 2n,
    cap = netLimit >> 128n;
  if (cap === 0n || market.fundingTime > timestamp || deadline < timestamp)
    throw new Error("invalid capital reservation policy");
  let apr = (((market.aggregateBase * mid) / BASE) * RATE) / cap;
  apr = apr > RATE ? RATE : apr < -RATE ? -RATE : apr;
  const change = (mid * abs(apr) * (timestamp - market.fundingTime)) / (RATE * YEAR),
    index = market.fundingIndex + (apr < 0n ? -change : change),
    payment = (position.size * (index - position.lastFundingIndex)) / BASE;
  const currentFundingDebit = payment < 0n ? -payment : 0n,
    quantity = abs(delta),
    executionNotional = (quantity * executionPrice) / BASE,
    entryNotional = (quantity * position.entryPrice) / BASE,
    existingNotional = (abs(position.size) * mid) / BASE;
  const seconds = deadline - timestamp,
    futureFunding = ((existingNotional + executionNotional) * seconds + YEAR - 1n) / YEAR;
  return currentFundingDebit + executionNotional + entryNotional + futureFunding;
}
/** Independent integer model of selected-market funding, realized PnL and canonical exposure bounds. */
export function exposureAdmission(input: {
  markets: [ExposureMarket, ExposureMarket];
  books: [ExposureBook, ExposureBook];
  netLimits: [bigint, bigint];
  market: 0 | 1;
  position: { size: bigint; entryPrice: bigint; lastFundingIndex: bigint };
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
  if (!books.every((book) => book.ready)) return reject("exposure_migration_required");
  const selected = markets[market],
    mid = (selected.lastBid + selected.lastAsk) / 2n,
    cap = netLimits[market] >> 128n;
  if (cap === 0n || selected.fundingTime > timestamp) return reject("invalid_policy");
  let apr = (((selected.aggregateBase * mid) / BASE) * RATE) / cap;
  apr = apr > RATE ? RATE : apr < -RATE ? -RATE : apr;
  const change = (mid * abs(apr) * (timestamp - selected.fundingTime)) / (RATE * YEAR),
    index = selected.fundingIndex + (apr < 0n ? -change : change),
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
  for (let i = 0; i < 2; i++) {
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
      !within(((longs + shorts) * state.lastAsk) / BASE, book.limits & MASK, gross) ||
      !within((longs * state.lastAsk) / BASE, book.limits >> 128n, long) ||
      !within((shorts * state.lastAsk) / BASE, book.limits >> 128n, short)
    )
      return reject("gross_or_side_cap");
    if (!within(abs(newNet[i]), netLimits[i] >> 128n, abs(oldNet[i]))) return reject("net_cap");
  }
  if (!within(makerStress(newNet[0], newNet[1]), backing / 4n, makerStress(oldNet[0], oldNet[1])))
    return reject("maker_stress");
  return { allowed: true, reason: "allowed", reduction };
}
