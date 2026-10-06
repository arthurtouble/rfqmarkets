import { DatabaseSync } from "node:sqlite";
import { JsonRpcProvider, Transaction, Wallet, keccak256, type TransactionRequest } from "ethers";

export interface IncludedReceipt {
  hash: string;
  blockNumber: number;
  blockHash: string;
  status: 1;
}
type RevertedReceipt = Omit<IncludedReceipt, "status"> & { status: 0 };
type Receipt = IncludedReceipt | RevertedReceipt;

/**
 * Journal statuses.
 * - signed: journaled before the first broadcast of this attempt.
 * - submitted: broadcast and waiting for a receipt.
 * - included / reverted: a canonical receipt exists for one of the operation's attempts.
 * - reorged: was included or reverted, the receipt disappeared and the nonce is still open, so the
 *   journaled transaction was rebroadcast and is waiting to be re-included.
 * - ambiguous: the nonce is consumed but no attempt has a receipt; needs an operator.
 * - superseded: another journaled operation was included at the same nonce.
 */
export type SenderStatus =
  "signed" | "submitted" | "included" | "reverted" | "reorged" | "ambiguous" | "superseded";
/** Statuses that fence new operations and mean the sponsor nonce is not settled. */
export const UNRESOLVED_SENDER_STATUSES: readonly SenderStatus[] = [
  "signed",
  "submitted",
  "ambiguous",
  "reorged",
];
const UNRESOLVED_SQL = UNRESOLVED_SENDER_STATUSES.map((status) => `'${status}'`).join(",");

class CanonicalRevert extends Error {
  constructor(public receipt: RevertedReceipt) {
    super(`transaction ${receipt.hash} reverted`);
  }
}
export interface SenderOptions {
  firstWaitMs?: number;
  replacementWaitMs?: number;
  pollMs?: number;
  maxReplacements?: number;
  bumpBps?: number;
  initialFeeBumpBps?: number;
  chainId?: bigint;
  maxFeePerGas?: bigint;
  maxGasLimit?: bigint;
  maxValue?: bigint;
  dailyBudgetWei?: bigint;
}
interface StoredTransaction {
  operation_id: string;
  nonce: number;
  tx_hash: string;
  raw_tx: string;
  status: SenderStatus;
}
interface FoundReceipt {
  receipt: Receipt;
  raw: string;
}

const bumpBy = (value: bigint, bps: number) => (value * BigInt(10_000 + bps)) / 10_000n + 1n;
const maximum = (...values: bigint[]) => values.reduce((best, value) => (value > best ? value : best), 0n);

/**
 * Single-lane sponsor transaction sender. Every transaction is signed and journaled before it is
 * broadcast, so a crash at any point can be resumed by rebroadcasting the exact journaled bytes.
 * An unresolved operation fences new ones so the sponsor nonce never forks.
 */
export class DurableSender {
  private tail: Promise<unknown> = Promise.resolve();
  constructor(
    private provider: JsonRpcProvider,
    private wallet: Wallet,
    private database?: DatabaseSync,
    private options: SenderOptions = {},
  ) {
    if (options.dailyBudgetWei !== undefined && !database)
      throw new Error("Daily sponsor budget requires a durable database");
    database?.exec(`
      CREATE TABLE IF NOT EXISTS sender_budget(day TEXT NOT NULL,operation_id TEXT NOT NULL,cost TEXT NOT NULL,PRIMARY KEY(day,operation_id));
      CREATE TABLE IF NOT EXISTS sender_transactions(operation_id TEXT PRIMARY KEY,nonce INTEGER NOT NULL,tx_hash TEXT NOT NULL UNIQUE,raw_tx TEXT NOT NULL,status TEXT NOT NULL,included_block INTEGER,included_hash TEXT,updated_ms INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS sender_attempts(operation_id TEXT NOT NULL,attempt INTEGER NOT NULL,nonce INTEGER NOT NULL,tx_hash TEXT NOT NULL UNIQUE,raw_tx TEXT NOT NULL,created_ms INTEGER NOT NULL,PRIMARY KEY(operation_id,attempt));
      CREATE INDEX IF NOT EXISTS sender_transactions_status ON sender_transactions(status,included_block);
      INSERT OR IGNORE INTO sender_attempts SELECT operation_id,0,nonce,tx_hash,raw_tx,updated_ms FROM sender_transactions;
    `);
  }

  submit(operationId: string, request: TransactionRequest) {
    return this.serialize(() => this.submitLocked(operationId, request));
  }

  /**
   * Re-checks every operation that is unresolved, or included/reverted above the finalized block
   * (the only rows a reorg can still change). Operations at or below the finalized block are
   * terminal and are never read again, so the cost is bounded by the finality window, not history.
   */
  reconcile() {
    return this.serialize(() => this.reconcileLocked());
  }

  status() {
    if (!this.database) return [];
    return this.database
      .prepare("SELECT status,count(*) count FROM sender_transactions GROUP BY status ORDER BY status")
      .all() as Array<{ status: SenderStatus; count: number }>;
  }

  /** True when an operation fences new submissions (see UNRESOLVED_SENDER_STATUSES). */
  hasUnresolved() {
    return this.status().some((row) => UNRESOLVED_SENDER_STATUSES.includes(row.status));
  }

  private serialize<T>(task: () => Promise<T>) {
    const run = this.tail.then(task);
    this.tail = run.catch(() => undefined);
    return run;
  }

  private async submitLocked(operationId: string, request: TransactionRequest): Promise<IncludedReceipt> {
    let stored = this.database
      ?.prepare(
        "SELECT operation_id,nonce,tx_hash,raw_tx,status FROM sender_transactions WHERE operation_id=?",
      )
      .get(operationId) as StoredTransaction | undefined;
    if (stored) {
      this.assertSameInput(stored, request);
      if (stored.status === "ambiguous" || stored.status === "superseded")
        throw new Error(`operation ${operationId} requires nonce reconciliation`);
      const found = await this.findReceipt(operationId);
      if (found) return this.settle(operationId, found);
      await this.broadcast(stored.raw_tx);
    } else {
      const unresolved = this.database
        ?.prepare(`SELECT operation_id FROM sender_transactions WHERE status IN (${UNRESOLVED_SQL}) LIMIT 1`)
        .get() as { operation_id: string } | undefined;
      if (unresolved)
        throw new Error(`unresolved sponsor operation ${unresolved.operation_id} blocks new submission`);
      stored = await this.signInitial(operationId, request);
      this.checkBudgetLimits(stored);
      this.writeInitial(stored);
      await this.broadcast(stored.raw_tx);
      this.markSubmitted(operationId);
    }
    let attempt = this.lastAttempt(operationId);
    const maxReplacements = this.options.maxReplacements ?? 1;
    for (let replacement = 0; replacement <= maxReplacements; replacement++) {
      const timeoutMs =
        replacement === 0 ? (this.options.firstWaitMs ?? 8_000) : (this.options.replacementWaitMs ?? 30_000);
      const receipt = await this.wait(stored.tx_hash, timeoutMs);
      if (receipt) return this.settle(operationId, { receipt, raw: stored.raw_tx });
      const found = await this.findReceipt(operationId);
      if (found) return this.settle(operationId, found);
      if (replacement === maxReplacements) break;
      stored = await this.replace(stored, ++attempt);
      await this.broadcast(stored.raw_tx);
      this.markSubmitted(operationId);
    }
    throw new Error(`transaction for ${operationId} was not included after ${maxReplacements + 1} attempts`);
  }

  private assertSameInput(stored: StoredTransaction, request: TransactionRequest) {
    const original = Transaction.from(stored.raw_tx);
    if (
      String(request.to ?? "").toLowerCase() !== String(original.to ?? "").toLowerCase() ||
      String(request.data ?? "0x").toLowerCase() !== original.data.toLowerCase() ||
      BigInt(String(request.value ?? 0)) !== original.value ||
      (request.gasLimit !== undefined && BigInt(String(request.gasLimit)) !== original.gasLimit) ||
      (request.chainId !== undefined && BigInt(String(request.chainId)) !== original.chainId) ||
      original.from?.toLowerCase() !== this.wallet.address.toLowerCase()
    )
      throw new Error(`operation ${stored.operation_id} input does not match its journaled transaction`);
  }

  private async signInitial(operationId: string, request: TransactionRequest): Promise<StoredTransaction> {
    const explicitFees = this.options.chainId !== undefined && request.gasLimit !== undefined;
    const [nonceHex, fees] = await Promise.all([
      this.provider.send("eth_getTransactionCount", [this.wallet.address, "pending"]),
      explicitFees ? this.provider.getFeeData() : Promise.resolve(undefined),
    ]);
    const nonce = Number(BigInt(nonceHex));
    let populated: TransactionRequest;
    if (explicitFees && fees) {
      populated = { ...request, nonce, chainId: this.options.chainId };
      if (request.maxFeePerGas === undefined && request.gasPrice === undefined) {
        const bump = (value: bigint) => bumpBy(value, this.options.initialFeeBumpBps ?? 0);
        if (fees.maxFeePerGas !== null && fees.maxPriorityFeePerGas !== null)
          populated = {
            ...populated,
            type: 2,
            maxFeePerGas: bump(fees.maxFeePerGas),
            maxPriorityFeePerGas: bump(fees.maxPriorityFeePerGas),
          };
        else if (fees.gasPrice !== null) populated = { ...populated, type: 0, gasPrice: bump(fees.gasPrice) };
        else throw new Error("fee data unavailable");
      }
    } else
      populated = await this.wallet.populateTransaction({ ...request, from: this.wallet.address, nonce });
    const raw = await this.wallet.signTransaction(populated);
    return { operation_id: operationId, nonce, tx_hash: keccak256(raw), raw_tx: raw, status: "signed" };
  }

  private lastAttempt(operationId: string) {
    const row = this.database
      ?.prepare("SELECT max(attempt) value FROM sender_attempts WHERE operation_id=?")
      .get(operationId) as { value: number | null } | undefined;
    return Number(row?.value ?? 0);
  }

  private transaction(work: (database: DatabaseSync) => void) {
    if (!this.database) return;
    this.database.exec("BEGIN IMMEDIATE");
    try {
      work(this.database);
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  private writeInitial(row: StoredTransaction) {
    this.transaction((database) => {
      this.reserveBudget(row);
      database
        .prepare("INSERT INTO sender_transactions VALUES(?,?,?,?,'signed',NULL,NULL,?)")
        .run(row.operation_id, row.nonce, row.tx_hash, row.raw_tx, Date.now());
      database
        .prepare("INSERT INTO sender_attempts VALUES(?,?,?,?,?,?)")
        .run(row.operation_id, 0, row.nonce, row.tx_hash, row.raw_tx, Date.now());
    });
  }

  private async replace(current: StoredTransaction, attempt: number) {
    const transaction = Transaction.from(current.raw_tx),
      bump = (value: bigint) => bumpBy(value, this.options.bumpBps ?? 1_500),
      fees = await this.provider.getFeeData();
    let request: TransactionRequest = {
      to: transaction.to,
      data: transaction.data,
      value: transaction.value,
      gasLimit: transaction.gasLimit,
      nonce: transaction.nonce,
      chainId: transaction.chainId,
    };
    if (transaction.type === 2) {
      const priority = maximum(bump(transaction.maxPriorityFeePerGas ?? 0n), fees.maxPriorityFeePerGas ?? 0n);
      request = {
        ...request,
        type: 2,
        maxPriorityFeePerGas: priority,
        maxFeePerGas: maximum(bump(transaction.maxFeePerGas ?? 0n), fees.maxFeePerGas ?? 0n, priority),
        accessList: transaction.accessList,
      };
    } else
      request = {
        ...request,
        type: 0,
        gasPrice: maximum(bump(transaction.gasPrice ?? 0n), fees.gasPrice ?? 0n),
      };
    const raw = await this.wallet.signTransaction(request),
      hash = keccak256(raw),
      next: StoredTransaction = { ...current, tx_hash: hash, raw_tx: raw, status: "signed" };
    this.checkBudgetLimits(next);
    this.transaction((database) => {
      this.reserveBudget(next);
      database
        .prepare("INSERT INTO sender_attempts VALUES(?,?,?,?,?,?)")
        .run(current.operation_id, attempt, current.nonce, hash, raw, Date.now());
      database
        .prepare(
          "UPDATE sender_transactions SET tx_hash=?,raw_tx=?,status='signed',included_block=NULL,included_hash=NULL,updated_ms=? WHERE operation_id=?",
        )
        .run(hash, raw, Date.now(), current.operation_id);
    });
    return next;
  }

  private checkBudgetLimits(row: StoredTransaction) {
    const tx = Transaction.from(row.raw_tx),
      fee = tx.maxFeePerGas ?? tx.gasPrice ?? 0n;
    if (
      (this.options.maxFeePerGas !== undefined && fee > this.options.maxFeePerGas) ||
      (this.options.maxGasLimit !== undefined && tx.gasLimit > this.options.maxGasLimit) ||
      (this.options.maxValue !== undefined && tx.value > this.options.maxValue)
    )
      throw new Error("Sponsor operation exceeds gas, fee or value budget");
  }

  private reserveBudget(row: StoredTransaction) {
    if (this.options.dailyBudgetWei === undefined) return;
    const tx = Transaction.from(row.raw_tx),
      cost = tx.gasLimit * (tx.maxFeePerGas ?? tx.gasPrice ?? 0n) + tx.value,
      day = new Date().toISOString().slice(0, 10),
      rows = this.database!.prepare("SELECT operation_id,cost FROM sender_budget WHERE day=?").all(
        day,
      ) as Array<{
        operation_id: string;
        cost: string;
      }>;
    let total = 0n,
      old = 0n;
    for (const item of rows) {
      if (item.operation_id === row.operation_id) old = BigInt(item.cost);
      else total += BigInt(item.cost);
    }
    const reserved = maximum(cost, old);
    if (total + reserved > this.options.dailyBudgetWei) throw new Error("Daily sponsor budget exhausted");
    this.database!.prepare(
      "INSERT INTO sender_budget VALUES(?,?,?) ON CONFLICT(day,operation_id) DO UPDATE SET cost=excluded.cost",
    ).run(day, row.operation_id, reserved.toString());
  }

  /**
   * "already known" and "nonce too low" are treated as accepted: the receipt reads that follow
   * decide whether this transaction or another one consumed the nonce.
   */
  private async broadcast(raw: string) {
    try {
      await this.provider.broadcastTransaction(raw);
    } catch (error) {
      const message = String(error);
      if (!message.includes("already known") && !message.includes("nonce too low")) throw error;
    }
  }

  private setStatus(operationId: string, status: SenderStatus) {
    this.database
      ?.prepare(
        "UPDATE sender_transactions SET status=?,included_block=NULL,included_hash=NULL,updated_ms=? WHERE operation_id=?",
      )
      .run(status, Date.now(), operationId);
  }

  private markSubmitted(operationId: string) {
    this.setStatus(operationId, "submitted");
  }

  private async wait(hash: string, timeoutMs: number) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const receipt = await this.readReceipt(hash);
      if (receipt) return receipt;
      await new Promise((resolve) => setTimeout(resolve, this.options.pollMs ?? 100));
    }
    return null;
  }

  private async readReceipt(hash: string): Promise<Receipt | null> {
    const raw = (await this.provider.send("eth_getTransactionReceipt", [hash])) as null | {
      transactionHash: string;
      blockNumber: string;
      blockHash: string;
      status: string;
    };
    if (!raw) return null;
    const status = BigInt(raw.status);
    if (status !== 0n && status !== 1n) throw new Error("invalid receipt status");
    return {
      hash: raw.transactionHash,
      blockNumber: Number(BigInt(raw.blockNumber)),
      blockHash: raw.blockHash,
      status: status === 1n ? 1 : 0,
    };
  }

  /** The canonical receipt of any journaled attempt of the operation, if one exists. */
  private async findReceipt(operationId: string): Promise<FoundReceipt | null> {
    if (!this.database) return null;
    const attempts = this.database
      .prepare("SELECT tx_hash,raw_tx FROM sender_attempts WHERE operation_id=? ORDER BY attempt")
      .all(operationId) as Array<{ tx_hash: string; raw_tx: string }>;
    const receipts = await Promise.all(attempts.map((row) => this.readReceipt(row.tx_hash)));
    const index = receipts.findIndex(Boolean);
    return index < 0 ? null : { receipt: receipts[index]!, raw: attempts[index].raw_tx };
  }

  /** Records a canonical receipt, then returns it or throws if it reverted. */
  private settle(operationId: string, found: FoundReceipt): IncludedReceipt {
    this.recordReceipt(operationId, found);
    if (found.receipt.status === 0) throw new CanonicalRevert(found.receipt);
    return found.receipt;
  }

  private recordReceipt(operationId: string, { receipt, raw }: FoundReceipt) {
    this.database
      ?.prepare(
        "UPDATE sender_transactions SET tx_hash=?,raw_tx=?,status=?,included_block=?,included_hash=?,updated_ms=? WHERE operation_id=?",
      )
      .run(
        receipt.hash,
        raw,
        receipt.status === 1 ? "included" : "reverted",
        receipt.blockNumber,
        receipt.blockHash,
        Date.now(),
        operationId,
      );
  }

  /** Highest finalized block seen; included rows at or below it are terminal. */
  private finalizedFloor = -1;

  private async refreshFinalizedFloor() {
    const block = (await this.provider.send("eth_getBlockByNumber", ["finalized", false])) as null | {
      number: string;
    };
    if (block) this.finalizedFloor = Math.max(this.finalizedFloor, Number(BigInt(block.number)));
  }

  private reconcileCandidates() {
    return this.database!.prepare(
      `SELECT operation_id,nonce,tx_hash,raw_tx,status FROM sender_transactions
       WHERE status IN (${UNRESOLVED_SQL}) OR (status IN ('included','reverted') AND included_block>?)
       ORDER BY nonce`,
    ).all(this.finalizedFloor) as unknown as StoredTransaction[];
  }

  private async reconcileLocked() {
    if (!this.database) return;
    // Read the mined nonce before any receipt: a nonce below it was consumed before the receipt
    // reads, so "no receipt for any attempt" then really means another transaction consumed it.
    const mined = Number(
      BigInt(await this.provider.send("eth_getTransactionCount", [this.wallet.address, "latest"])),
    );
    let rows = this.reconcileCandidates();
    if (rows.some((row) => row.status === "included" || row.status === "reverted")) {
      await this.refreshFinalizedFloor();
      rows = this.reconcileCandidates();
    }
    const found = await Promise.all(rows.map((row) => this.findReceipt(row.operation_id)));
    for (const [index, row] of rows.entries()) {
      if (found[index]) {
        this.recordReceipt(row.operation_id, found[index]);
        continue;
      }
      if (row.nonce < mined) {
        const replacement = this.database
          .prepare(
            "SELECT operation_id FROM sender_transactions WHERE nonce=? AND status='included' AND operation_id<>? LIMIT 1",
          )
          .get(row.nonce, row.operation_id);
        this.setStatus(row.operation_id, replacement ? "superseded" : "ambiguous");
        continue;
      }
      const wasIncluded = row.status === "included" || row.status === "reverted" || row.status === "reorged";
      try {
        await this.broadcast(row.raw_tx);
        this.setStatus(row.operation_id, wasIncluded ? "reorged" : "submitted");
      } catch {
        this.setStatus(row.operation_id, "ambiguous");
      }
    }
  }
}
