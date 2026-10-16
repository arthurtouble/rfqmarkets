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

/** Markets where the account holds a position, ascending; each must be a known market. */
function openLegs(item: KeeperAccount) {
  const legs: number[] = [];
  for (const [label, position] of Object.entries(item.positions)) {
    if (BigInt(position.size) === 0n) continue;
    const index = marketIndexOf(label);
    if (index === undefined) {
      // A market added after this keeper's last registry refresh: refresh and retry next cycle.
      marketRegistry.requestRefresh(0);
      throw new Error(`keeper cannot map market ${label}`);
    }
    legs.push(index);
  }
  return legs.sort((a, b) => a - b);
}

/** Accounts awaiting a retry because their legs could not all be refreshed in one cycle. */
const MAX_RETRY_ACCOUNTS = 64;
/** Unwinds a cycle that must stop writing: resolution started or the keeper is shutting down. */
const HALT = Symbol("keeper halt");

/** The contract's MAX_ORACLE_AGE is 15 s. A price older than this is refreshed before it is needed. */
const REFRESH_AFTER_SECONDS = 8;
/**
 * Oldest price a write that depends on it is attempted with, leaving room for inclusion before the contract's
 * 15 s limit (a stale leg would make the simulation revert and the account would be skipped silently).
 */
const MAX_DEPENDENT_AGE_SECONDS = 10;
/** How often every market with open interest is refreshed so maker capital can be assessed. */
const INCIDENT_SWEEP_SECONDS = 30;
/** A maker capital assessment this overdue fails the cycle (and health) instead of passing silently. */
const INCIDENT_OVERDUE_SECONDS = 120;

/** One writer, bounded work, with chain state re-read after every financial write. */
export class KeeperEngine {
  private running?: Promise<void>;
  private cursor?: string;
  private stopped = false;
  private error?: string;
  private completedAt?: number;
  private lastFailure?: string;
  /** Chain time maker capital was last assessed with every open market fresh. */
  private assessedAt?: number;
  /** Chain time of the first cycle, so a keeper that never assesses is flagged too. */
  private startedAt?: number;
  /** First market the next sweep refreshes, so a budget smaller than the market count reaches every market. */
  private rotation = 0;
  /**
   * Accounts passed over because their other legs could not all be made fresh in one cycle (many legs, little
   * budget). They are retried first each cycle, so one account cannot pin the position cursor.
   */
  private readonly retry = new Map<string, KeeperAccount>();
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
    // Refreshes are writes too. They never take more than about half the cycle's writes, so liquidations always
    // get the rest, and only prices a pending write depends on are refreshed, shortly before they would lapse.
    const refreshLimit = Math.max(
        1,
        this.limits.maxTransactions - Math.floor(this.limits.maxTransactions / 2),
      ),
      age = (market: number) => state.timestamp - (state.priceTimes[market] ?? 0);
    let refreshes = 0;
    /** False when the budget is spent; throws Halt when the refresh started resolution or shutdown. */
    const refresh = async (market: number) => {
      if (refreshes >= refreshLimit || writes >= this.limits.maxTransactions) return false;
      refreshes++;
      await execute({ kind: "refresh", market, proof: await proof(market) });
      if (state.resolutionRequired || this.stopped) throw HALT;
      return true;
    };
    this.startedAt ??= state.timestamp;
    try {
      // Maker capital (the incident check) is assessed against every market with open interest, so those are
      // swept fresh periodically, starting at a rotating market. In between, it is assessed whenever they
      // happen to be fresh, which costs no write.
      const markets = state.priceTimes.map((_, market) => market).filter(open);
      if (this.assessedAt === undefined || state.timestamp - this.assessedAt >= INCIDENT_SWEEP_SECONDS) {
        const count = state.priceTimes.length || 1,
          start = this.rotation % count;
        this.rotation = start + 1;
        const due = markets
          .filter((market) => age(market) > REFRESH_AFTER_SECONDS)
          .sort((a, b) => ((a - start + count) % count) - ((b - start + count) % count));
        for (const market of due) if (!(await refresh(market))) break;
      }
      if (markets.every((market) => age(market) <= MAX_DEPENDENT_AGE_SECONDS)) {
        await execute({ kind: "incident" });
        if (state.resolutionRequired || this.stopped) return;
        this.assessedAt = state.timestamp;
      }
      await this.liquidatePage({
        execute,
        proof,
        age,
        writesLeft: () => (this.stopped ? 0 : this.limits.maxTransactions - writes),
        halted: () => state.resolutionRequired || this.stopped,
      });
    } catch (error) {
      if (error === HALT) return;
      throw error;
    }
    if (state.timestamp - (this.assessedAt ?? this.startedAt) > INCIDENT_OVERDUE_SECONDS)
      throw new Error("keeper could not refresh cross-market prices");
  }

  /**
   * Liquidates down the indexer's position list, after the accounts left for retry. Liquidation refreshes its
   * own market's price; every other leg the account holds must be fresh, so those are refreshed first, using
   * any write but the one the liquidation itself needs. An account whose legs still cannot all be made fresh
   * is remembered for retry and the cursor moves past it. Throws HALT when resolution started or the keeper
   * is stopping.
   */
  private async liquidatePage(cycle: {
    execute: (action: KeeperAction) => Promise<boolean>;
    proof: (market: number) => Promise<KeeperProof>;
    age: (market: number) => number;
    writesLeft: () => number;
    halted: () => boolean;
  }) {
    /** "done" (liquidated or not liquidatable), "blocked" (stale legs) or "budget" (no write left). */
    const attempt = async (item: KeeperAccount, account: string) => {
      const [market, ...others] = openLegs(item);
      if (market === undefined) return "done";
      if (cycle.writesLeft() < 1) return "budget";
      for (const leg of others) {
        if (cycle.age(leg) <= REFRESH_AFTER_SECONDS) continue;
        if (cycle.writesLeft() < 2) break;
        await cycle.execute({ kind: "refresh", market: leg, proof: await cycle.proof(leg) });
        if (cycle.halted()) throw HALT;
      }
      if (others.some((leg) => cycle.age(leg) > MAX_DEPENDENT_AGE_SECONDS)) return "blocked";
      if (cycle.writesLeft() < 1) return "budget";
      await cycle.execute({ kind: "liquidate", account, market, proof: await cycle.proof(market) });
      if (cycle.halted()) throw HALT;
      return "done";
    };
    for (const [account, item] of [...this.retry]) {
      const outcome = await attempt(item, account);
      if (outcome === "budget") return;
      if (outcome === "done") this.retry.delete(account);
    }
    const page = await this.deps.accounts(this.cursor, this.limits.accountsPerCycle);
    if (page.items.length > this.limits.accountsPerCycle) throw new Error("oversized keeper page");
    for (let index = 0; index < page.items.length; index++) {
      if (cycle.writesLeft() < 1) return;
      const item = page.items[index],
        account = getAddress(item.account);
      if (this.cursor && account <= this.cursor) throw new Error("nonmonotonic keeper page");
      if (!this.retry.has(account)) {
        const outcome = await attempt(item, account);
        if (outcome === "budget") return;
        if (outcome === "blocked") {
          // Bounded: past the cap the cursor waits on this account, as it would without the retry list.
          if (this.retry.size >= MAX_RETRY_ACCOUNTS) return;
          this.retry.set(account, item);
        }
      }
      this.cursor = account;
    }
    if (!page.nextCursor) this.cursor = undefined;
    else if (page.nextCursor !== this.cursor) throw new Error("inconsistent keeper cursor");
  }
}
