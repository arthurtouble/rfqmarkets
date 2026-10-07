import { getAddress, keccak256, toUtf8Bytes } from "ethers";
import { marketRegistry } from "../../../packages/shared/src/markets.js";

export interface KeeperState {
  resolutionRequired: boolean;
  resolutionPricesReady: boolean;
  resolutionFinalized: boolean;
  resolutionCursor: bigint;
  /** Per market index, for every market the chain has. */
  sampleCounts: number[];
  priceTimes: number[];
  /**
   * Per market index: customers hold gross exposure there. Only such markets need fresh prices and
   * resolution samples, so a market without exposure (e.g. one just added, not yet priced) never
   * blocks the keeper. Missing means every market counts as open.
   */
  openInterest?: boolean[];
  timestamp: number;
}
export interface KeeperAccount {
  account: string;
  /** Per market symbol, as the indexer reports them (`market #i` for one its registry lacks). */
  positions: Record<string, { size: string }>;
}
export interface KeeperProof {
  report: string;
  observedAt: number;
  validUntil: number;
}
export type KeeperAction =
  | { kind: "refresh" | "sample"; market: number; proof: KeeperProof }
  | { kind: "liquidate"; market: number; account: string; proof: KeeperProof }
  | { kind: "process"; cursor: bigint; maxAccounts: number }
  | { kind: "incident" };
export interface KeeperDependencies {
  reconcile(): Promise<boolean>;
  state(): Promise<KeeperState>;
  proof(market: number): Promise<KeeperProof>;
  accounts(
    cursor: string | undefined,
    limit: number,
  ): Promise<{ items: KeeperAccount[]; nextCursor: string | null }>;
  // False means an explicit canonical simulation revert. Transport failures throw.
  execute(id: string, action: KeeperAction): Promise<boolean>;
}

/** Index of a market label: a registry symbol, or `market #i` for one the indexer's registry lacked. */
export function marketIndexOf(label: string): number | undefined {
  if (marketRegistry.has(label)) return marketRegistry.index(label);
  const match = /^market #(\d+)$/.exec(label);
  return match ? Number(match[1]) : undefined;
}

/** The lowest-index market where the account holds a position; it must be a known market. */
function firstOpenMarket(item: KeeperAccount) {
  let first: number | undefined;
  for (const [label, position] of Object.entries(item.positions)) {
    if (BigInt(position.size) === 0n) continue;
    const index = marketIndexOf(label);
    if (index === undefined) {
      // A market added after this keeper's last registry refresh: refresh and retry next cycle.
      marketRegistry.requestRefresh(0);
      throw new Error(`keeper cannot map market ${label}`);
    }
    if (first === undefined || index < first) first = index;
  }
  return first;
}

/** One writer, bounded work, with chain state re-read after every financial write. */
export class KeeperEngine {
  private running?: Promise<void>;
  private cursor?: string;
  private stopped = false;
  private error?: string;
  private completedAt?: number;
  private lastFailure?: string;
  constructor(
    private deps: KeeperDependencies,
    private limits = { accountsPerCycle: 25, maxTransactions: 4, resolutionPage: 50 },
    /** Receives each distinct cycle failure once; public status only shows a generic code. */
    private onError: (error: unknown) => void = (error) => console.error("keeper cycle failed:", error),
  ) {
    for (const [name, value] of Object.entries(limits))
      if (!Number.isInteger(value) || value < 1 || value > 200) throw new Error(`invalid keeper ${name}`);
  }
  status() {
    return {
      ok:
        !this.error &&
        !this.stopped &&
        this.completedAt !== undefined &&
        Date.now() - this.completedAt < 30_000,
      lastCompletedAt: this.completedAt,
      error: this.error,
      running: !!this.running,
    };
  }
  cycle() {
    if (this.stopped) return Promise.resolve();
    if (this.running) return this.running;
    this.running = this.run()
      .then(() => {
        this.error = this.lastFailure = undefined;
        this.completedAt = Date.now();
      })
      .catch((error) => {
        this.error = "keeper_cycle_failed";
        const failure = String(error);
        if (failure !== this.lastFailure) this.onError(error);
        this.lastFailure = failure;
      })
      .finally(() => {
        this.running = undefined;
      });
    return this.running;
  }
  async close() {
    this.stopped = true;
    await this.running;
  }
  private async run() {
    if (!(await this.deps.reconcile())) throw new Error("unresolved keeper sponsor");
    let state = await this.deps.state(),
      writes = 0;
    const execute = async (action: KeeperAction) => {
      if (this.stopped || writes >= this.limits.maxTransactions) return false;
      const payload = JSON.stringify(action, (_, value) =>
        typeof value === "bigint" ? value.toString() : value,
      );
      const accepted = await this.deps.execute(`keeper:${keccak256(toUtf8Bytes(payload))}`, action);
      if (accepted) {
        writes++;
        state = await this.deps.state();
      }
      return accepted;
    };
    const proof = async (market: number) => {
      const item = await this.deps.proof(market);
      if (
        item.observedAt > state.timestamp + 2 ||
        item.observedAt < state.timestamp - 15 ||
        item.validUntil < state.timestamp + 4
      )
        throw new Error("keeper proof lacks safe inclusion time");
      return item;
    };
    const open = (market: number) => state.openInterest?.[market] ?? true;
    if (state.resolutionFinalized) return;
    if (state.resolutionRequired) {
      if (state.resolutionPricesReady) {
        await execute({
          kind: "process",
          cursor: state.resolutionCursor,
          maxAccounts: this.limits.resolutionPage,
        });
        return;
      }
      // Prices are ready once every market with open interest has its samples; a further
      // sample for an idle market would revert.
      for (let market = 0; market < state.sampleCounts.length; market++) {
        if (state.resolutionPricesReady) return;
        if (!open(market)) continue;
        if (state.sampleCounts[market] < 3 && writes < this.limits.maxTransactions)
          await execute({ kind: "sample", market, proof: await proof(market) });
      }
      return;
    }
    // Every leg with open interest must be fresh before cross-margin liquidation, including at zero net.
    for (let market = 0; market < state.priceTimes.length; market++) {
      if (open(market) && state.timestamp - state.priceTimes[market] > 5) {
        await execute({ kind: "refresh", market, proof: await proof(market) });
        if (state.resolutionRequired || this.stopped) return;
      }
    }
    if (writes >= this.limits.maxTransactions) return;
    if (state.priceTimes.some((time, market) => open(market) && state.timestamp - time > 15))
      throw new Error("keeper could not refresh cross-market prices");
    await execute({ kind: "incident" });
    if (state.resolutionRequired || this.stopped) return;
    const page = await this.deps.accounts(this.cursor, this.limits.accountsPerCycle);
    if (page.items.length > this.limits.accountsPerCycle) throw new Error("oversized keeper page");
    for (let index = 0; index < page.items.length; index++) {
      if (this.stopped || writes >= this.limits.maxTransactions) return;
      const item = page.items[index],
        account = getAddress(item.account);
      if (this.cursor && account <= this.cursor) throw new Error("nonmonotonic keeper page");
      const market = firstOpenMarket(item);
      if (market !== undefined)
        await execute({ kind: "liquidate", account, market, proof: await proof(market) });
      this.cursor = account;
      if (state.resolutionRequired) return;
    }
    if (!page.nextCursor) this.cursor = undefined;
    else if (page.nextCursor !== this.cursor) throw new Error("inconsistent keeper cursor");
  }
}
