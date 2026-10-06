/**
 * Typed converters from RFQClearing view structs (ethers `Result`s, whose fields
 * are untyped) to the bigint models used by the risk code.
 */
import type { BigNumberish } from "ethers";
import type { ExposureBook, ExposureMarket, PositionState } from "./exposure-admission.js";
import { BASE } from "./numeric.js";

/** `markets(uint256)` */
export interface ClearingMarketStruct {
  aggregateBase: BigNumberish;
  fundingIndex: BigNumberish;
  fundingTime: BigNumberish;
  lastPriceTime: BigNumberish;
  lastBid: BigNumberish;
  lastAsk: BigNumberish;
  enabled: unknown;
}
/** `exposureState(uint8)` */
export interface ClearingBookStruct {
  longBase: BigNumberish;
  shortBase: BigNumberish;
  limits: BigNumberish;
  ready: unknown;
}
/** `positionOf(address,uint8)` */
export interface ClearingPositionStruct {
  size: BigNumberish;
  entryPrice: BigNumberish;
  lastFundingIndex: BigNumberish;
}
/** `sessions(address)` */
export interface ClearingSessionStruct {
  account: string;
  validUntil: BigNumberish;
  marketMask: BigNumberish;
  maxTradeNotional: BigNumberish;
  maxCumulativeNotional: BigNumberish;
  usedNotional: BigNumberish;
  maxFee: BigNumberish;
}
export interface SessionState {
  account: string;
  validUntil: bigint;
  marketMask: number;
  maxTradeNotional: bigint;
  maxCumulativeNotional: bigint;
  usedNotional: bigint;
  maxFee: bigint;
}

export const toExposureMarket = (value: ClearingMarketStruct): ExposureMarket => ({
  aggregateBase: BigInt(value.aggregateBase),
  fundingIndex: BigInt(value.fundingIndex),
  fundingTime: BigInt(value.fundingTime),
  lastPriceTime: BigInt(value.lastPriceTime),
  lastBid: BigInt(value.lastBid),
  lastAsk: BigInt(value.lastAsk),
  enabled: Boolean(value.enabled),
});

export const toExposureBook = (value: ClearingBookStruct): ExposureBook => ({
  longBase: BigInt(value.longBase),
  shortBase: BigInt(value.shortBase),
  limits: BigInt(value.limits),
  ready: Boolean(value.ready),
});

export const toPosition = (value: ClearingPositionStruct): PositionState => ({
  size: BigInt(value.size),
  entryPrice: BigInt(value.entryPrice),
  lastFundingIndex: BigInt(value.lastFundingIndex),
});

export const toSession = (value: ClearingSessionStruct): SessionState => ({
  account: value.account,
  validUntil: BigInt(value.validUntil),
  marketMask: Number(value.marketMask),
  maxTradeNotional: BigInt(value.maxTradeNotional),
  maxCumulativeNotional: BigInt(value.maxCumulativeNotional),
  usedNotional: BigInt(value.usedNotional),
  maxFee: BigInt(value.maxFee),
});

export const marketMid = (market: Pick<ExposureMarket, "lastBid" | "lastAsk">) =>
  (market.lastBid + market.lastAsk) / 2n;

/** Signed maker net notional of a market at `mark` (defaults to the stored mid). */
export const marketNotional = (
  market: Pick<ExposureMarket, "aggregateBase" | "lastBid" | "lastAsk">,
  mark = marketMid(market),
) => (market.aggregateBase * mark) / BASE;
