import { getAddress } from "ethers";
import type { FastifyInstance } from "fastify";
import { openingPnl, positionPnl } from "../../../packages/shared/src/account-risk.js";
import { BASE, marginRate } from "../../../packages/shared/src/policy.js";
import type { ApiContext } from "./context.js";
import { abs, MARKETS, type Market } from "./markets.js";
import { publicError } from "./public-error.js";
import type { MarketView, QuoteEngine } from "./quoting.js";

export type AccountPosition = { size: bigint; entryPrice: bigint; lastFundingIndex: bigint };
type MarketPrices = Record<Market, Pick<MarketView, "bid" | "ask" | "mid" | "projectedFundingIndex">>;

/** Bisection steps for the liquidation-price estimate; 80 halvings exceed bigint price precision. */
const LIQUIDATION_SEARCH_STEPS = 80;
/** Short liquidation prices are searched up to this multiple of the current mid. */
const SHORT_SEARCH_CEILING = 20n;

const marginOf = (notional: bigint, initial: boolean) => (notional * marginRate(notional, initial)) / 10_000n;

/**
 * Account equity, margin and per-position liquidation estimates at the snapshot prices. Longs are
 * marked at the bid and shorts at the ask, matching the clearing contract's conservative marks.
 */
export function accountView(
  collateral: bigint,
  positions: Record<Market, AccountPosition>,
  markets: MarketPrices,
) {
  let unrealizedPnl = 0n,
    accruedFunding = 0n,
    grossNotional = 0n,
    initialMargin = 0n,
    maintenanceMargin = 0n;
  const views: Record<string, Record<string, string | null>> = {},
    pnls: bigint[] = [];
  for (const name of MARKETS) {
    const { size, entryPrice, lastFundingIndex } = positions[name],
      market = markets[name],
      mark = size >= 0n ? BigInt(market.bid) : BigInt(market.ask),
      notional = (abs(size) * BigInt(market.ask)) / BASE,
      pnl = positionPnl(size, entryPrice, mark),
      fundingPnl = (-size * (BigInt(market.projectedFundingIndex) - lastFundingIndex)) / BASE;
    pnls.push(pnl);
    unrealizedPnl += pnl;
    accruedFunding += fundingPnl;
    grossNotional += notional;
    initialMargin += marginOf(notional, true);
    maintenanceMargin += marginOf(notional, false);
    views[name] = {
      size: size.toString(),
      entryPrice: entryPrice.toString(),
      markPrice: mark.toString(),
      notional: notional.toString(),
      unrealizedPnl: pnl.toString(),
      accruedFunding: fundingPnl.toString(),
      lastFundingIndex: lastFundingIndex.toString(),
    };
  }
  const equity = collateral + unrealizedPnl + accruedFunding,
    openingEquity = collateral + accruedFunding + openingPnl(pnls);

  /** Maintenance health with market `selected` moved to `candidateMid`, scaling its bid and ask. */
  const healthAt = (selected: Market, candidateMid: bigint) => {
    let value = collateral + accruedFunding,
      required = 0n;
    for (const name of MARKETS) {
      const { size, entryPrice } = positions[name];
      if (size === 0n) continue;
      const current = markets[name],
        scale = (price: string) =>
          name === selected ? (candidateMid * BigInt(price)) / BigInt(current.mid) : BigInt(price),
        bid = scale(current.bid),
        ask = scale(current.ask);
      value += positionPnl(size, entryPrice, size > 0n ? bid : ask);
      required += marginOf((abs(size) * ask) / BASE, false);
    }
    return value - required;
  };
  for (const name of MARKETS) {
    const { size } = positions[name];
    if (size === 0n) continue;
    const currentMid = BigInt(markets[name].mid);
    let liquidation: bigint | null = null;
    if (healthAt(name, currentMid) <= 0n) liquidation = currentMid;
    else {
      // Longs lose health as price falls, shorts as it rises. Bisect to the healthy side of the
      // boundary: `high` converges on the liquidation price for both directions.
      let low = size > 0n ? 1n : currentMid,
        high = size > 0n ? currentMid : currentMid * SHORT_SEARCH_CEILING;
      if (healthAt(name, size > 0n ? low : high) <= 0n) {
        for (let step = 0; step < LIQUIDATION_SEARCH_STEPS; step++) {
          const middle = (low + high) / 2n,
            healthy = healthAt(name, middle) > 0n;
          if (size > 0n === healthy) high = middle;
          else low = middle;
        }
        liquidation = high;
      }
    }
    views[name].estimatedLiquidationPrice = liquidation?.toString() ?? null;
  }
  return {
    collateral: collateral.toString(),
    equity: equity.toString(),
    openingEquity: openingEquity.toString(),
    unrealizedPnl: unrealizedPnl.toString(),
    accruedFunding: accruedFunding.toString(),
    grossNotional: grossNotional.toString(),
    initialMargin: initialMargin.toString(),
    maintenanceMargin: maintenanceMargin.toString(),
    availableMargin: (openingEquity - initialMargin).toString(),
    maintenanceBuffer: (equity - maintenanceMargin).toString(),
    marginRatioBps: equity > 0n ? ((maintenanceMargin * 10_000n) / equity).toString() : null,
    effectiveLeverageBps: equity > 0n ? ((grossNotional * 10_000n) / equity).toString() : null,
    liquidatable: equity < maintenanceMargin,
    positions: views,
  };
}

/** The portfolio read model: one block-pinned set of clearing reads priced at the market snapshot. */
export function registerAccountRoutes(app: FastifyInstance, ctx: ApiContext, quoting: QuoteEngine) {
  app.get("/v1/account/:address", async (request, reply) => {
    const { clearing } = ctx;
    if (!clearing) return reply.code(503).send({ error: "chain unavailable" });
    let account: string;
    try {
      account = getAddress((request.params as { address: string }).address);
    } catch {
      return reply.code(400).send({ error: "invalid account" });
    }
    try {
      const snapshot = await quoting.readMarkets(),
        blockTag = { blockTag: snapshot.blockNumber };
      const [collateral, btc, eth, maintenanceEquity, openingEquity, initialMargin, maintenanceMargin] =
        await Promise.all([
          clearing.collateralOf(account, blockTag),
          clearing.positionOf(account, 0, blockTag),
          clearing.positionOf(account, 1, blockTag),
          clearing.maintenanceEquity(account, blockTag),
          clearing.openingEquity(account, blockTag),
          clearing.initialMargin(account, blockTag),
          clearing.maintenanceMargin(account, blockTag),
        ]);
      const position = (raw: AccountPosition): AccountPosition => ({
        size: BigInt(raw.size),
        entryPrice: BigInt(raw.entryPrice),
        lastFundingIndex: BigInt(raw.lastFundingIndex),
      });
      const { positions, ...summary } = accountView(
        BigInt(collateral),
        { BTC: position(btc), ETH: position(eth) },
        snapshot.markets,
      );
      return {
        account,
        blockNumber: snapshot.blockNumber,
        ...summary,
        positions,
        onchain: {
          maintenanceEquity: maintenanceEquity.toString(),
          openingEquity: openingEquity.toString(),
          initialMargin: initialMargin.toString(),
          maintenanceMargin: maintenanceMargin.toString(),
        },
      };
    } catch (error) {
      // A valid address that cannot be read is an upstream outage, not a bad request.
      return reply.code(503).send({ error: publicError(error, "account data unavailable") });
    }
  });
}
