// Account portfolio history replayed from indexed clearing events. Realized PnL mirrors
// RFQRiskMath.positionTransition exactly, so the replayed ledger reconciles with on-chain collateral:
// collateral = netDeposits + realizedPnl - fees + funding - liquidationPenalties + deficitCovered, where
// netDeposits also counts margin moved to or from isolated accounts (MarginTransferred).
// Amounts are USDC micro-units, sizes are 1e18 base units, prices are USDC micro-units per whole base unit.

import { marketRegistry, type Market } from "../../../packages/shared/src/markets.js";

export const BASE_UNIT = 10n ** 18n;
/** A market symbol from the registry (`market #i` for an index the registry does not know yet). */
export type PortfolioMarket = Market;

/** One activity row as stored by the indexer (payload already JSON-decoded). */
export interface PortfolioEvent {
  txHash: string;
  logIndex: number;
  blockNumber: number;
  /** Block timestamp, unix seconds. */
  timestamp: number;
  kind: string;
  payload: Record<string, string>;
  /** Oracle side stored at the end of a Liquidated event's block (bid, ask), for partial closes. */
  liquidationMark?: { bid: bigint; ask: bigint };
}

export interface Fill {
  txHash: string;
  logIndex: number;
  blockNumber: number;
  timeMs: number;
  /** trade = TradeExecuted, close = PositionClosed, liquidation = partial keeper close (price estimated). */
  kind: "trade" | "close" | "liquidation";
  market: PortfolioMarket;
  baseDelta: string;
  price: string;
  fee: string;
  notional: string;
  sizeBefore: string;
  sizeAfter: string;
  entryPriceBefore: string;
  entryPriceAfter: string;
  realizedPnl: string;
  cumulativeRealizedPnl: string;
}

export interface FundingItem {
  txHash: string;
  logIndex: number;
  blockNumber: number;
  timeMs: number;
  market: PortfolioMarket;
  /** As emitted: positive means the account paid. */
  payment: string;
  /** Effect on the account's PnL (= -payment). */
  amount: string;
  cumulativeFunding: string;
}

export interface PortfolioTotals {
  realizedPnl: bigint;
  fees: bigint;
  funding: bigint;
  liquidationPenalties: bigint;
  deficitCovered: bigint;
  deposits: bigint;
  withdrawals: bigint;
  /** Net margin moved in from (positive) or out to (negative) the owner's isolated accounts or their owner. */
  transfers: bigint;
  volume: bigint;
  tradeCount: number;
}

export interface PortfolioPoint {
  /** Unix milliseconds of the block holding the event (or the bucket start when bucketed). */
  timeMs: number;
  blockNumber: number;
  realizedPnl: string;
  fees: string;
  funding: string;
  liquidationPenalties: string;
  /** realizedPnl - fees + funding - liquidationPenalties. */
  netPnl: string;
  /** deposits - withdrawals + transfers. */
  netDeposits: string;
  /** netDeposits + netPnl + deficitCovered: the replayed collateral balance. */
  collateral: string;
}

export interface PortfolioReplay {
  totals: PortfolioTotals;
  /** Every registered market, plus any other market the account traded. */
  positions: Record<PortfolioMarket, { size: bigint; entryPrice: bigint }>;
  fills: Fill[];
  funding: FundingItem[];
  /** One point per block that changed any total, ascending. */
  points: PortfolioPoint[];
  firstEventMs: number | null;
  lastEventMs: number | null;
  /** True when a partial liquidation had no stored oracle mark, so its realized PnL is unknown (counted as 0). */
  incomplete: boolean;
}

const abs = (value: bigint) => (value < 0n ? -value : value);
const min = (a: bigint, b: bigint) => (a < b ? a : b);

/** RFQRiskMath.positionTransition: next size, next entry price and realized PnL. */
export function positionTransition(oldSize: bigint, oldEntry: bigint, delta: bigint, price: bigint) {
  const nextSize = oldSize + delta;
  if (oldSize === 0n || oldSize > 0n === delta > 0n) {
    const combined = abs(nextSize);
    const nextEntry = combined === 0n ? 0n : (abs(oldSize) * oldEntry + abs(delta) * price) / combined;
    return { nextSize, nextEntry, realizedPnl: 0n };
  }
  const closed = min(abs(delta), abs(oldSize));
  const realizedPnl =
    oldSize > 0n
      ? (closed * price) / BASE_UNIT - (closed * oldEntry) / BASE_UNIT
      : (closed * oldEntry) / BASE_UNIT - (closed * price) / BASE_UNIT;
  const nextEntry = nextSize === 0n ? 0n : nextSize > 0n !== oldSize > 0n ? price : oldEntry;
  return { nextSize, nextEntry, realizedPnl };
}

const marketOf = (value: string | undefined): PortfolioMarket | undefined => {
  if (value === undefined || !/^\d+$/.test(value)) return undefined;
  return marketRegistry.hasIndex(Number(value)) ? marketRegistry.symbol(Number(value)) : `market #${value}`;
};

/** Replays an account's events, which must be in ascending (blockNumber, logIndex) order. */
export function replayPortfolio(events: readonly PortfolioEvent[]): PortfolioReplay {
  const totals: PortfolioTotals = {
      realizedPnl: 0n,
      fees: 0n,
      funding: 0n,
      liquidationPenalties: 0n,
      deficitCovered: 0n,
      deposits: 0n,
      withdrawals: 0n,
      transfers: 0n,
      volume: 0n,
      tradeCount: 0,
    },
    positions: PortfolioReplay["positions"] = marketRegistry.record(() => ({ size: 0n, entryPrice: 0n })),
    fills: Fill[] = [],
    funding: FundingItem[] = [],
    points: PortfolioPoint[] = [];
  let incomplete = false;

  const fill = (
    event: PortfolioEvent,
    kind: Fill["kind"],
    market: PortfolioMarket,
    delta: bigint,
    price: bigint,
    fee: bigint,
  ) => {
    const position = (positions[market] ??= { size: 0n, entryPrice: 0n }),
      next = positionTransition(position.size, position.entryPrice, delta, price),
      notional = (abs(delta) * price) / BASE_UNIT;
    totals.realizedPnl += next.realizedPnl;
    fills.push({
      txHash: event.txHash,
      logIndex: event.logIndex,
      blockNumber: event.blockNumber,
      timeMs: event.timestamp * 1_000,
      kind,
      market,
      baseDelta: delta.toString(),
      price: price.toString(),
      fee: fee.toString(),
      notional: notional.toString(),
      sizeBefore: position.size.toString(),
      sizeAfter: next.nextSize.toString(),
      entryPriceBefore: position.entryPrice.toString(),
      entryPriceAfter: next.nextEntry.toString(),
      realizedPnl: next.realizedPnl.toString(),
      cumulativeRealizedPnl: totals.realizedPnl.toString(),
    });
    position.size = next.nextSize;
    position.entryPrice = next.nextEntry;
    return notional;
  };

  const point = (event: PortfolioEvent) => {
    const netPnl = totals.realizedPnl - totals.fees + totals.funding - totals.liquidationPenalties,
      netDeposits = totals.deposits - totals.withdrawals + totals.transfers,
      value: PortfolioPoint = {
        timeMs: event.timestamp * 1_000,
        blockNumber: event.blockNumber,
        realizedPnl: totals.realizedPnl.toString(),
        fees: totals.fees.toString(),
        funding: totals.funding.toString(),
        liquidationPenalties: totals.liquidationPenalties.toString(),
        netPnl: netPnl.toString(),
        netDeposits: netDeposits.toString(),
        collateral: (netDeposits + netPnl + totals.deficitCovered).toString(),
      };
    // One point per block: later events in the same block replace the earlier point.
    if (points.at(-1)?.blockNumber === event.blockNumber) points[points.length - 1] = value;
    else points.push(value);
  };

  for (let start = 0; start < events.length;) {
    let end = start + 1;
    while (end < events.length && events[end].txHash === events[start].txHash) end++;
    const tx = events.slice(start, end);
    // A keeper's partial close (RFQLiquidation.liquidate, equity > 0) emits no fill event, only Liquidated.
    // It is the partial branch unless the same transaction closed that leg's whole size via PositionClosed.
    const partials = tx.filter((event) => {
      if (event.kind !== "Liquidated") return false;
      const market = marketOf(event.payload.market);
      if (!market) return false;
      const size = abs(positions[market]?.size ?? 0n);
      return !tx.some(
        (other) =>
          other.kind === "PositionClosed" &&
          other.payload.market === event.payload.market &&
          abs(BigInt(other.payload.baseDelta)) === size,
      );
    });
    let partialsApplied = false;
    const applyPartials = () => {
      if (partialsApplied) return;
      partialsApplied = true;
      for (const event of partials) {
        const market = marketOf(event.payload.market)!,
          size = positions[market]?.size ?? 0n,
          closed = BigInt(event.payload.closedBase);
        if (size === 0n || closed === 0n) continue;
        const delta = size > 0n ? -min(closed, size) : min(closed, -size);
        if (!event.liquidationMark) {
          incomplete = true;
          // Keep sizes right even when the price is unknown: close at entry (zero realized PnL).
          fill(event, "liquidation", market, delta, positions[market]?.entryPrice ?? 0n, 0n);
          continue;
        }
        fill(
          event,
          "liquidation",
          market,
          delta,
          size > 0n ? event.liquidationMark.bid : event.liquidationMark.ask,
          0n,
        );
      }
    };
    for (const event of tx) {
      const payload = event.payload,
        market = marketOf(payload.market);
      switch (event.kind) {
        case "Deposited":
          totals.deposits += BigInt(payload.amount);
          break;
        case "Withdrawn":
          totals.withdrawals += BigInt(payload.amount);
          break;
        case "MarginTransferred":
          totals.transfers += BigInt(payload.amount);
          break;
        case "FundingSettled": {
          if (!market) continue;
          const payment = BigInt(payload.payment);
          totals.funding -= payment;
          funding.push({
            txHash: event.txHash,
            logIndex: event.logIndex,
            blockNumber: event.blockNumber,
            timeMs: event.timestamp * 1_000,
            market,
            payment: payment.toString(),
            amount: (-payment).toString(),
            cumulativeFunding: totals.funding.toString(),
          });
          break;
        }
        case "TradeExecuted": {
          if (!market) continue;
          const fee = BigInt(payload.fee);
          totals.fees += fee;
          totals.volume += fill(
            event,
            "trade",
            market,
            BigInt(payload.baseDelta),
            BigInt(payload.price),
            fee,
          );
          totals.tradeCount++;
          break;
        }
        case "PositionClosed":
          if (!market) continue;
          applyPartials();
          fill(event, "close", market, BigInt(payload.baseDelta), BigInt(payload.price), 0n);
          break;
        case "Liquidated":
          applyPartials();
          totals.liquidationPenalties += BigInt(payload.penalty);
          break;
        case "DeficitAbsorbed":
          totals.deficitCovered +=
            BigInt(payload.insuranceUsed) + BigInt(payload.makerUsed) + BigInt(payload.unresolved);
          break;
        default:
          continue;
      }
      point(event);
    }
    start = end;
  }
  return {
    totals,
    positions,
    fills,
    funding,
    points,
    firstEventMs: events.length ? events[0].timestamp * 1_000 : null,
    lastEventMs: events.length ? events[events.length - 1].timestamp * 1_000 : null,
    incomplete,
  };
}

export const HISTORY_INTERVALS = { event: 0, "1h": 3_600_000, "1d": 86_400_000 } as const;
export type HistoryInterval = keyof typeof HISTORY_INTERVALS;

/** Keeps the last point of each bucket, stamped with the bucket start; "event" keeps every point. */
export function bucketPoints(points: readonly PortfolioPoint[], interval: HistoryInterval) {
  const size = HISTORY_INTERVALS[interval];
  if (!size) return [...points];
  const buckets: PortfolioPoint[] = [];
  for (const item of points) {
    const timeMs = Math.floor(item.timeMs / size) * size,
      value = { ...item, timeMs };
    if (buckets.at(-1)?.timeMs === timeMs) buckets[buckets.length - 1] = value;
    else buckets.push(value);
  }
  return buckets;
}
