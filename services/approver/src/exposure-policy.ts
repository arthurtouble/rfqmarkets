import { marketNotional } from "../../../packages/shared/src/clearing-structs.js";
import type { MakerApproval, TradeIntent } from "../../../packages/shared/src/eip712.js";
import {
  exposureAdmission,
  isPositionReduction,
  pendingMakerDebit,
  type ExposureMarket,
  type PositionState,
} from "../../../packages/shared/src/exposure-admission.js";
import type {
  GrossReservationBook,
  GrossRiskContext,
} from "../../../packages/shared/src/gross-reservations.js";
import { MARKETS, otherMarketIndex, type MarketIndex } from "../../../packages/shared/src/markets.js";
import { BASE, abs, low128 } from "../../../packages/shared/src/numeric.js";
import { impactCost, type Exposure } from "../../../packages/shared/src/pricing.js";
import type { ChainSnapshot } from "./chain-state.js";
import { APPROVAL_LIFETIME_SECONDS } from "./envelope.js";
import type { SafetyPrices } from "./oracle-policy.js";
import { MAX_TRADE_NOTIONAL } from "./pricing-policy.js";
import { reject, type Rejection } from "./rejection.js";

/** Gross reservations in a market need a stored price at most this old. */
export const MAX_GROSS_PRICE_AGE_SECONDS = 15;

/** Opening trades must fit the static ceiling and the market's per-trade limit. */
export function checkTradeLimit(input: {
  positionSize: bigint;
  delta: bigint;
  notional: bigint;
  executionNotional: bigint;
  limitWord: bigint;
}): Rejection | undefined {
  if (
    !isPositionReduction(input.positionSize, input.delta) &&
    (input.notional > MAX_TRADE_NOTIONAL || input.executionNotional > low128(input.limitWord))
  )
    return reject("market trade limit exceeded");
}

export function checkChainTimeExpiry(
  intent: TradeIntent,
  approval: MakerApproval,
  blockTimestamp: number,
  maxFutureSeconds: number,
): Rejection | undefined {
  const now = BigInt(blockTimestamp);
  if (
    intent.deadline <= now ||
    approval.deadline <= now ||
    approval.deadline > BigInt(blockTimestamp + APPROVAL_LIFETIME_SECONDS + maxFutureSeconds)
  )
    return reject("chain-time expiry rejected");
}

/** Disabled markets accept only position reductions. */
export function checkMarketEnabled(
  market: ExposureMarket,
  positionSize: bigint,
  delta: bigint,
): Rejection | undefined {
  if (!market.enabled && !isPositionReduction(positionSize, delta)) return reject("market disabled");
}

/** Chain markets with the intent market re-marked at the verified safety prices. */
export function markedMarkets(
  snapshot: ChainSnapshot,
  market: MarketIndex,
  prices: SafetyPrices,
  priceTime: bigint,
): [ExposureMarket, ExposureMarket] {
  const markets: [ExposureMarket, ExposureMarket] = [snapshot.markets[0], snapshot.markets[1]];
  markets[market] = {
    ...markets[market],
    lastBid: prices.bid,
    lastAsk: prices.ask,
    lastPriceTime: priceTime,
  };
  return markets;
}

/** Independent integer model of funding, realized PnL, gross/net caps and maker stress. */
export function checkExposure(input: {
  snapshot: ChainSnapshot;
  markets: [ExposureMarket, ExposureMarket];
  market: MarketIndex;
  intent: TradeIntent;
  approval: MakerApproval;
}): Rejection | undefined {
  const { snapshot, intent } = input;
  const admission = exposureAdmission({
    markets: input.markets,
    books: snapshot.books,
    netLimits: snapshot.limitWords,
    market: input.market,
    position: snapshot.position,
    delta: intent.baseDelta,
    executionPrice: input.approval.executionPrice,
    timestamp: BigInt(snapshot.blockTimestamp),
    backing: snapshot.backing,
    floor: snapshot.floor,
  });
  if (!admission.allowed)
    return reject("independent exposure check rejected", 409, { reason: admission.reason });
  if (intent.reduceOnly && !admission.reduction) return reject("reduce-only intent does not reduce position");
}

/** Outstanding gross reservations in the other market need a fresh stored price there. */
export function checkCrossMarketFreshness(
  grossReservations: GrossReservationBook,
  grossId: string,
  snapshot: ChainSnapshot,
  market: MarketIndex,
): Rejection | undefined {
  const other = otherMarketIndex(market),
    priorGross = grossReservations.bounds(grossId),
    otherPriceTime = Number(snapshot.markets[other].lastPriceTime);
  if (
    priorGross[other].longBase + priorGross[other].shortBase > 0n &&
    (otherPriceTime === 0 || snapshot.blockTimestamp - otherPriceTime > MAX_GROSS_PRICE_AGE_SECONDS)
  )
    return reject("outstanding gross risk requires fresh cross-market price");
}

/** Inputs for `GrossReservationBook.admit` derived from the chain snapshot. */
export interface GrossContext {
  books: ChainSnapshot["books"];
  asks: [bigint, bigint];
  block: number;
  makerDebit: bigint;
  risk: GrossRiskContext;
}

export function buildGrossContext(input: {
  snapshot: ChainSnapshot;
  markets: [ExposureMarket, ExposureMarket];
  market: MarketIndex;
  position: PositionState;
  intent: TradeIntent;
  approval: MakerApproval;
}): GrossContext {
  const { snapshot, markets, market, intent, approval } = input;
  return {
    books: snapshot.books,
    asks: [markets[0].lastAsk, markets[1].lastAsk],
    block: snapshot.blockNumber,
    makerDebit: pendingMakerDebit({
      position: input.position,
      market: markets[market],
      delta: intent.baseDelta,
      executionPrice: approval.executionPrice,
      timestamp: BigInt(snapshot.blockTimestamp),
      deadline: approval.deadline,
      netLimit: snapshot.limitWords[market],
    }),
    risk: {
      net: [marketNotional(markets[0]), marketNotional(markets[1])],
      netLimits: snapshot.limitWords,
      backing: snapshot.backing,
      floor: snapshot.floor,
    },
  };
}

/**
 * The approved impact charge must cover the quadratic inventory cost of this
 * trade at the safety mark, and the execution price must actually deliver it
 * relative to the safety touch.
 */
export function checkImpact(input: {
  markets: [ExposureMarket, ExposureMarket];
  market: MarketIndex;
  prices: SafetyPrices;
  intent: TradeIntent;
  approval: MakerApproval;
}): Rejection | undefined {
  const { markets, market, prices, intent, approval } = input;
  const exposure: Exposure = { BTC: marketNotional(markets[0]), ETH: marketNotional(markets[1]) },
    delta = (intent.baseDelta * prices.mark) / BASE,
    absoluteBase = abs(intent.baseDelta),
    deliveredImpact =
      intent.baseDelta > 0n
        ? (absoluteBase * approval.executionPrice) / BASE - (absoluteBase * prices.ask) / BASE
        : (absoluteBase * prices.bid) / BASE - (absoluteBase * approval.executionPrice) / BASE;
  if (
    approval.impactCharge < impactCost(exposure, MARKETS[market], delta) ||
    deliveredImpact < approval.impactCharge
  )
    return reject("independent impact check rejected");
}
