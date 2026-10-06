export type AccountProjection = { account: string; collateral: string; btc_size: string; eth_size: string };
type MarketTotals = { longBase: bigint; shortBase: bigint; longAccounts: number; shortAccounts: number };

export class RiskProjection {
  private accounts = new Map<string, { collateral: bigint; btc: bigint; eth: bigint }>();
  private collateral = 0n;
  private markets: Record<"BTC" | "ETH", MarketTotals> = {
    BTC: { longBase: 0n, shortBase: 0n, longAccounts: 0, shortAccounts: 0 },
    ETH: { longBase: 0n, shortBase: 0n, longAccounts: 0, shortAccounts: 0 },
  };
  clear() {
    this.accounts.clear();
    this.collateral = 0n;
    this.markets = {
      BTC: { longBase: 0n, shortBase: 0n, longAccounts: 0, shortAccounts: 0 },
      ETH: { longBase: 0n, shortBase: 0n, longAccounts: 0, shortAccounts: 0 },
    };
  }
  update(row: AccountProjection) {
    const prior = this.accounts.get(row.account);
    if (prior) this.adjust(prior, -1n);
    const next = { collateral: BigInt(row.collateral), btc: BigInt(row.btc_size), eth: BigInt(row.eth_size) };
    this.accounts.set(row.account, next);
    this.adjust(next, 1n);
  }
  snapshot(indexedBlock: number) {
    const market = (value: MarketTotals) => ({
      longBase: value.longBase.toString(),
      shortBase: value.shortBase.toString(),
      netBase: (value.longBase - value.shortBase).toString(),
      longAccounts: value.longAccounts,
      shortAccounts: value.shortAccounts,
    });
    return {
      indexedBlock,
      accountCount: this.accounts.size,
      totalCollateral: this.collateral.toString(),
      markets: { BTC: market(this.markets.BTC), ETH: market(this.markets.ETH) },
    };
  }
  private adjust(row: { collateral: bigint; btc: bigint; eth: bigint }, direction: bigint) {
    this.collateral += row.collateral * direction;
    this.adjustMarket(this.markets.BTC, row.btc, direction);
    this.adjustMarket(this.markets.ETH, row.eth, direction);
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
