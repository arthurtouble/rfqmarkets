import { keccak256 } from "ethers";
import type { ApproverPayload } from "../../../packages/shared/src/approver-payload.js";
import type { MarketIndex } from "../../../packages/shared/src/markets.js";
import { decodeLocalReport, type OracleObservation } from "../../../packages/shared/src/oracle-report.js";
import { decodeSignedReport } from "../../../packages/shared/src/signed-oracle.js";
import type { OracleMode } from "./options.js";
import { reject, type Rejection } from "./rejection.js";

/** Oldest oracle observation accepted, matching the contract's settlement freshness. */
export const MAX_ORACLE_AGE_SECONDS = 8n;
/** Widest bid/ask band (of mid) accepted for risk marks. */
export const MAX_ORACLE_WIDTH_BPS = 100n;

/** True when the observation is from the future, expired, or older than the freshness bound at `nowSeconds`. */
export function observationOutsideWindow(
  observation: Pick<OracleObservation, "observedAt" | "validUntil">,
  nowSeconds: bigint,
  maxFutureSeconds: number,
) {
  return (
    observation.observedAt > nowSeconds + BigInt(maxFutureSeconds) ||
    nowSeconds > observation.validUntil ||
    (observation.observedAt <= nowSeconds && nowSeconds - observation.observedAt > MAX_ORACLE_AGE_SECONDS)
  );
}

/**
 * Decode the observation for `market` carried by a leader-supplied report.
 * Signed-oracle reports carry node batches whose consensus price only the
 * adapter computes, so in signed mode the result is undefined once the market
 * is present; `approve` dry-runs the adapter for the real observation. Throws
 * on malformed reports or a report without the market.
 */
export function decodeReportObservation(
  report: string,
  market: MarketIndex,
  oracle: { oracleMode?: OracleMode },
): OracleObservation | undefined {
  if (oracle.oracleMode === "signed") {
    if (!decodeSignedReport(report).some((batch) => batch.prices.some((price) => price.market === market)))
      throw new Error("signed report lacks market");
    return undefined;
  }
  return decodeLocalReport(report).find((observation) => observation.market === BigInt(market));
}

/**
 * The report must hash to the approval's `oracleReportHash` and, when it
 * carries a price, match the quote's bid/ask. Without a chain connection the
 * observation window is checked against wall time; with one it is checked
 * against block time by `checkChainTimeOracle`.
 */
export function checkSubmittedReport(input: {
  report: string;
  oracleReportHash: string;
  market: MarketIndex;
  quote: Pick<ApproverPayload["quote"], "bid" | "ask">;
  oracle: { oracleMode?: OracleMode };
  nowMs: number;
  maxFutureSeconds: number;
  checkWallClock: boolean;
}): { rejection?: Rejection; observation?: OracleObservation } {
  const { report, market, quote } = input;
  if (report === "0x") return {};
  try {
    if (keccak256(report) !== input.oracleReportHash) return { rejection: reject("oracle hash mismatch") };
    const observation = decodeReportObservation(report, market, input.oracle);
    if (input.oracle.oracleMode !== "signed" && !observation) throw new Error("missing oracle observation");
    if (!observation) return {};
    const wallTimeInvalid =
      input.checkWallClock &&
      observationOutsideWindow(observation, BigInt(Math.floor(input.nowMs / 1_000)), input.maxFutureSeconds);
    if (
      observation.market !== BigInt(market) ||
      observation.bid !== BigInt(quote.bid) ||
      observation.ask !== BigInt(quote.ask) ||
      observation.bid <= 0n ||
      observation.ask < observation.bid ||
      wallTimeInvalid
    )
      return { rejection: reject("oracle report rejected") };
    return { observation };
  } catch {
    return { rejection: reject("oracle report rejected") };
  }
}

/**
 * The signed adapter's consensus (median across nodes) can differ from any one
 * node's price in the quote payload. Validate that actual observation instead
 * of rejecting it merely because its price differs.
 */
export function checkVerifiedObservation(
  observation: OracleObservation,
  market: MarketIndex,
): Rejection | undefined {
  if (observation.market !== BigInt(market) || observation.bid <= 0n || observation.ask < observation.bid)
    return reject("oracle report rejected");
}

export function checkChainTimeOracle(
  observation: OracleObservation | undefined,
  blockTimestamp: number,
  maxFutureSeconds: number,
): Rejection | undefined {
  if (observation && observationOutsideWindow(observation, BigInt(blockTimestamp), maxFutureSeconds))
    return reject("chain-time oracle rejected");
}

export interface SafetyPrices {
  bid: bigint;
  ask: bigint;
  mark: bigint;
}

/** Risk marks: the verified observation when present, otherwise the quote's touch. */
export function safetyPrices(
  observation: OracleObservation | undefined,
  quote: Pick<ApproverPayload["quote"], "bid" | "ask">,
): SafetyPrices {
  const bid = observation?.bid ?? BigInt(quote.bid),
    ask = observation?.ask ?? BigInt(quote.ask);
  return { bid, ask, mark: (bid + ask) / 2n };
}

export function checkOracleWidth(prices: SafetyPrices): Rejection | undefined {
  if ((prices.ask - prices.bid) * 10_000n > prices.mark * MAX_ORACLE_WIDTH_BPS)
    return reject("oracle width rejected");
}
