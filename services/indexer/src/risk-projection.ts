import { marketRegistry } from "../../../packages/shared/src/markets.js";

/** An indexed account: collateral and its open position sizes by market index. */
export type AccountProjection = {
  account: string;
  collateral: string;
  /** Size (1e18 base units) per market index; markets without a position may be left out. */
  sizes: ReadonlyMap<number, string>;
};
type MarketTotals = { longBase: bigint; shortBase: bigint; longAccounts: number; shortAccounts: number };
const emptyTotals = (): MarketTotals => ({ longBase: 0n, shortBase: 0n, longAccounts: 0, shortAccounts: 0 });

/** Display name of a market index: its registry symbol, or `market #i` while the registry lags. */
export const marketLabel = (index: number) =>
  marketRegistry.hasIndex(index) ? marketRegistry.symbol(index) : `market #${index}`;

export class RiskProjection {
  private accounts = new Map<string, { collateral: bigint; sizes: Map<number, bigint> }>();
  private collateral = 0n;
  private markets = new Map<number, MarketTotals>();
  clear() {
    this.accounts.clear();
    this.collateral = 0n;
    this.markets.clear();
  }
  update(row: AccountProjection) {
    const prior = this.accounts.get(row.account);
    if (prior) this.adjust(prior, -1n);
    const sizes = new Map<number, bigint>();
    for (const [market, size] of row.sizes) if (BigInt(size) !== 0n) sizes.set(market, BigInt(size));
    const next = { collateral: BigInt(row.collateral), sizes };
    this.accounts.set(row.account, next);
    this.adjust(next, 1n);
  }
  /** Totals for every registered market (zero when nobody holds it) and any other market with positions. */
  snapshot(indexedBlock: number) {
    const market = (value: MarketTotals) => ({
      longBase: value.longBase.toString(),
      shortBase: value.shortBase.toString(),
      netBase: (value.longBase - value.shortBase).toString(),
      longAccounts: value.longAccounts,
      shortAccounts: value.shortAccounts,
    });
    const indexes = new Set([...marketRegistry.all().map((item) => item.index), ...this.markets.keys()]);
    return {
      indexedBlock,
      accountCount: this.accounts.size,
      totalCollateral: this.collateral.toString(),
      markets: Object.fromEntries(
        [...indexes]
          .sort((left, right) => left - right)
          .map((index) => [marketLabel(index), market(this.markets.get(index) ?? emptyTotals())]),
      ),
    };
  }
  private adjust(row: { collateral: bigint; sizes: Map<number, bigint> }, direction: bigint) {
    this.collateral += row.collateral * direction;
    for (const [index, size] of row.sizes) {
      let total = this.markets.get(index);
      if (!total) this.markets.set(index, (total = emptyTotals()));
      this.adjustMarket(total, size, direction);
    }
  }
  private adjustMarket(total: MarketTotals, value: bigint, direction: bigint) {
    if (value > 0n) {
      total.longBase += value * direction;
      total.longAccounts += Number(direction);
    } else if (value < 0n) {
      total.shortBase -= value * direction;
      total.shortAccounts += Number(direction);
    }
  }
}
