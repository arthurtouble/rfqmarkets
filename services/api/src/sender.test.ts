import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { Transaction, Wallet, keccak256 } from "ethers";
import { DurableSender } from "./sender.js";

type Receipt = { transactionHash: string; blockNumber: string; blockHash: string; status: string };

class DeterministicProvider {
  minedNonce = 0;
  finalized = 0;
  holdInMempool = false;
  mempool = new Map<string, Receipt>();
  broadcasts: string[] = [];
  receipts = new Map<string, Receipt>();
  receiptReads: string[] = [];
  failBeforeAccept = false;
  failAfterAccept = false;
  revertNext = false;
  get pendingNonce() {
    return this.minedNonce + this.mempool.size;
  }
  async getFeeData() {
    return { gasPrice: null, maxFeePerGas: 2_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n };
  }
  async send(method: string, params: unknown[]) {
    if (method === "eth_getTransactionCount")
      return `0x${(params[1] === "latest" ? this.minedNonce : this.pendingNonce).toString(16)}`;
    if (method === "eth_getTransactionReceipt") {
      this.receiptReads.push(String(params[0]));
      return this.receipts.get(String(params[0])) ?? null;
    }
    if (method === "eth_getBlockByNumber" && params[0] === "finalized")
      return { number: `0x${this.finalized.toString(16)}` };
    throw new Error(`unsupported ${method}`);
  }
  mine() {
    for (const [hash, receipt] of this.mempool) this.receipts.set(hash, receipt);
    this.minedNonce += this.mempool.size;
    this.mempool.clear();
  }
  async broadcastTransaction(raw: string) {
    if (this.failBeforeAccept) {
      this.failBeforeAccept = false;
      throw new Error("transport failed before acceptance");
    }
    const transaction = Transaction.from(raw),
      hash = keccak256(raw);
    this.broadcasts.push(raw);
    if (this.receipts.has(hash) || transaction.nonce < this.minedNonce) throw new Error("nonce too low");
    const receipt = {
      transactionHash: hash,
      blockNumber: `0x${(101 + transaction.nonce).toString(16)}`,
      blockHash: `0x${hash.slice(2).padEnd(64, "0")}`,
      status: "0x1",
    };
    if (this.revertNext) {
      this.revertNext = false;
      receipt.status = "0x0";
    }
    if (this.holdInMempool) this.mempool.set(hash, receipt);
    else {
      this.receipts.set(hash, receipt);
      this.minedNonce = Math.max(this.minedNonce, transaction.nonce + 1);
    }
    if (this.failAfterAccept) {
      this.failAfterAccept = false;
      throw new Error("transport failed after acceptance");
    }
    return {};
  }
}

const options = { chainId: 31_337n, firstWaitMs: 20, replacementWaitMs: 20, pollMs: 1, maxReplacements: 0 };
const request = {
  to: "0x0000000000000000000000000000000000000001",
  data: "0x1234",
  value: 0n,
  gasLimit: 100_000n,
};
const rows = (database: DatabaseSync) =>
  database
    .prepare("SELECT operation_id,nonce,tx_hash,status FROM sender_transactions ORDER BY nonce")
    .all() as Array<{ operation_id: string; nonce: number; tx_hash: string; status: string }>;
const randomWallet = () => new Wallet(Wallet.createRandom().privateKey);

test("canonical revert is durable, unblocks later nonces and remains reorg-sensitive", async () => {
  const provider = new DeterministicProvider(),
    database = new DatabaseSync(":memory:"),
    wallet = randomWallet(),
    sender = new DurableSender(provider as never, wallet, database, options);
  provider.revertNext = true;
  await assert.rejects(sender.submit("failed", request), /reverted/);
  assert.equal(rows(database)[0].status, "reverted");
  const restarted = new DurableSender(provider as never, wallet, database, options);
  await assert.rejects(restarted.submit("failed", request), /reverted/);
  assert.equal(provider.broadcasts.length, 1, "known revert must not be rebroadcast");
  await restarted.reconcile();
  assert.equal(rows(database)[0].status, "reverted");
  await restarted.submit("later", request);
  assert.equal(rows(database)[1].nonce, 1);
  const failed = rows(database)[0];
  provider.receipts.delete(failed.tx_hash);
  await restarted.reconcile();
  assert.equal(rows(database)[0].status, "ambiguous", "orphaned revert must no longer prove consumed nonce");
  await assert.rejects(restarted.submit("blocked", request), /unresolved sponsor operation/);
  provider.receipts.set(failed.tx_hash, {
    transactionHash: failed.tx_hash,
    blockNumber: "0x200",
    blockHash: "0x" + "ab".repeat(32),
    status: "0x0",
  });
  await restarted.reconcile();
  assert.equal(rows(database)[0].status, "reverted", "new canonical inclusion must resolve ambiguity");
  database.close();
});

test("a queued operation whose signed deadline passed is dropped before signing", async () => {
  const provider = new DeterministicProvider(),
    database = new DatabaseSync(":memory:"),
    wallet = randomWallet(),
    sender = new DurableSender(provider as never, wallet, database, options),
    now = Math.floor(Date.now() / 1_000);
  await assert.rejects(sender.submit("stale", request, { deadline: now - 1 }), /expired before broadcast/);
  assert.equal(provider.broadcasts.length, 0, "an expired action must not spend sponsor gas");
  assert.equal(rows(database).length, 0, "nothing is journaled for a dropped operation");
  await sender.submit("fresh", request, { deadline: now + 120 });
  assert.equal(rows(database)[0].nonce, 0, "the dropped operation did not consume a sponsor nonce");
  // A journaled operation resumes even after its deadline: its bytes may already be on the network.
  assert.equal(
    (await sender.submit("fresh", request, { deadline: now - 1 })).hash,
    rows(database)[0].tx_hash,
  );
  database.close();
});

test("parallel operations serialize onto unique consecutive sponsor nonces", async () => {
  const provider = new DeterministicProvider(),
    database = new DatabaseSync(":memory:"),
    wallet = randomWallet();
  const sender = new DurableSender(provider as never, wallet, database, options);
  const receipts = await Promise.all(
    Array.from({ length: 100 }, (_, index) => sender.submit(`parallel-${index}`, request)),
  );
  assert.equal(new Set(receipts.map((item) => item.hash)).size, 100);
  const journal = rows(database);
  assert.equal(journal.length, 100);
  assert.deepEqual(
    journal.map((item) => item.nonce),
    Array.from({ length: 100 }, (_, index) => index),
  );
  assert(journal.every((item) => item.status === "included"));
  assert.equal(provider.minedNonce, 100);
  database.close();
});

test("restart rebroadcasts the exact journaled transaction after a pre-accept crash", async () => {
  const provider = new DeterministicProvider(),
    database = new DatabaseSync(":memory:"),
    wallet = randomWallet();
  provider.failBeforeAccept = true;
  const first = new DurableSender(provider as never, wallet, database, options);
  await assert.rejects(first.submit("before-accept", request), /before acceptance/);
  const signed = rows(database)[0];
  assert.equal(signed.status, "signed");
  assert.equal(provider.broadcasts.length, 0);
  const restarted = new DurableSender(provider as never, wallet, database, options),
    receipt = await restarted.submit("before-accept", request);
  assert.equal(receipt.hash, signed.tx_hash);
  assert.equal(provider.broadcasts.length, 1);
  assert.equal(rows(database)[0].status, "included");
  database.close();
});

test("restart discovers inclusion after an ambiguous post-accept transport crash", async () => {
  const provider = new DeterministicProvider(),
    database = new DatabaseSync(":memory:"),
    wallet = randomWallet();
  provider.failAfterAccept = true;
  const first = new DurableSender(provider as never, wallet, database, options);
  await assert.rejects(first.submit("after-accept", request), /after acceptance/);
  const signed = rows(database)[0];
  assert.equal(signed.status, "signed");
  assert.equal(provider.broadcasts.length, 1);
  assert(provider.receipts.has(signed.tx_hash));
  const restarted = new DurableSender(provider as never, wallet, database, options),
    receipt = await restarted.submit("after-accept", request);
  assert.equal(receipt.hash, signed.tx_hash);
  assert.equal(provider.broadcasts.length, 1, "included transaction was needlessly rebroadcast");
  assert.equal(rows(database)[0].status, "included");
  database.close();
});

test("reconcile marks an externally consumed nonce ambiguous instead of guessing success", async () => {
  const provider = new DeterministicProvider(),
    database = new DatabaseSync(":memory:"),
    wallet = randomWallet();
  provider.failBeforeAccept = true;
  const sender = new DurableSender(provider as never, wallet, database, options);
  await assert.rejects(sender.submit("lost", request));
  provider.minedNonce = 1;
  await sender.reconcile();
  assert.equal(rows(database)[0].status, "ambiguous");
  database.close();
});

test("operation IDs bind destination, calldata, value, gas and signing authority", async () => {
  const provider = new DeterministicProvider(),
    database = new DatabaseSync(":memory:"),
    wallet = randomWallet(),
    sender = new DurableSender(provider as never, wallet, database, options);
  await sender.submit("bound", request);
  for (const change of [
    { data: "0x5678" },
    { value: 1n },
    { gasLimit: 100_001n },
    { to: "0x0000000000000000000000000000000000000002" },
    { chainId: 1n },
  ])
    await assert.rejects(sender.submit("bound", { ...request, ...change }), /input does not match/);
  await assert.rejects(
    new DurableSender(provider as never, randomWallet(), database, options).submit("bound", request),
    /input does not match/,
  );
  assert.equal(provider.broadcasts.length, 1);
  database.close();
});

test("a crash before broadcast fences new operation IDs until the original is reconciled", async () => {
  const provider = new DeterministicProvider(),
    database = new DatabaseSync(":memory:"),
    sender = new DurableSender(provider as never, randomWallet(), database, options);
  provider.failBeforeAccept = true;
  await assert.rejects(sender.submit("old", request), /before acceptance/);
  await assert.rejects(sender.submit("new", request), /unresolved sponsor operation/);
  assert.equal(rows(database).length, 1);
  await sender.submit("old", request);
  await sender.submit("new", request);
  assert.deepEqual(
    rows(database).map((row) => row.nonce),
    [0, 1],
  );
  database.close();
});

test("sponsor ceilings and durable daily budget fail before broadcast without partial journal writes", async () => {
  const provider = new DeterministicProvider(),
    database = new DatabaseSync(":memory:"),
    wallet = randomWallet();
  const sender = new DurableSender(provider as never, wallet, database, {
    ...options,
    maxGasLimit: 100000n,
    maxValue: 0n,
    dailyBudgetWei: 300_000_000_000_000n,
  });
  await assert.rejects(sender.submit("oversize", { ...request, gasLimit: 100001n }), /budget/);
  assert.equal(rows(database).length, 0);
  await sender.submit("first", request);
  await assert.rejects(sender.submit("second", request), /Daily sponsor budget exhausted/);
  assert.equal(rows(database).length, 1);
  assert.equal(provider.broadcasts.length, 1);
  assert.equal(database.prepare("SELECT count(*) n FROM sender_budget").get()!.n, 1);
  await sender.submit("first", request);
  assert.equal(provider.broadcasts.length, 1);
  database.close();
});

test("reconcile reads receipts only for unresolved and not-yet-finalized operations", async () => {
  const provider = new DeterministicProvider(),
    database = new DatabaseSync(":memory:"),
    sender = new DurableSender(provider as never, randomWallet(), database, options);
  for (let index = 0; index < 20; index++) await sender.submit(`history-${index}`, request);
  provider.finalized = 101 + 17; // nonces 0..17 are final, 18 and 19 are still reorgable
  provider.receiptReads = [];
  await sender.reconcile();
  const recent = new Set(
    rows(database)
      .slice(18)
      .map((row) => row.tx_hash),
  );
  assert.equal(provider.receiptReads.length, 2);
  assert(provider.receiptReads.every((hash) => recent.has(hash)));
  provider.finalized = 1_000;
  provider.receiptReads = [];
  await sender.reconcile();
  assert.equal(provider.receiptReads.length, 0, "finalized history must not be re-read");
  assert(rows(database).every((row) => row.status === "included"));
  database.close();
});

test("an included operation whose receipt is reorged out is rebroadcast and fences until re-included", async () => {
  const provider = new DeterministicProvider(),
    database = new DatabaseSync(":memory:"),
    sender = new DurableSender(provider as never, randomWallet(), database, options);
  await sender.submit("reorged", request);
  const included = rows(database)[0];
  provider.receipts.delete(included.tx_hash);
  provider.minedNonce = 0;
  provider.holdInMempool = true;
  await sender.reconcile();
  assert.equal(rows(database)[0].status, "reorged");
  assert.equal(provider.broadcasts.length, 2, "reorged transaction must be rebroadcast");
  assert.equal(sender.hasUnresolved(), true);
  await assert.rejects(sender.submit("blocked", request), /unresolved sponsor operation reorged/);
  await sender.reconcile();
  assert.equal(rows(database)[0].status, "reorged", "still waiting for re-inclusion");
  provider.mine();
  await sender.reconcile();
  assert.equal(rows(database)[0].status, "included");
  assert.equal(sender.hasUnresolved(), false);
  database.close();
});

test("an included operation whose receipt vanished never supersedes itself", async () => {
  const provider = new DeterministicProvider(),
    database = new DatabaseSync(":memory:"),
    sender = new DurableSender(provider as never, randomWallet(), database, options);
  await sender.submit("vanished", request);
  provider.receipts.delete(rows(database)[0].tx_hash);
  await sender.reconcile();
  assert.equal(rows(database)[0].status, "ambiguous", "nonce consumed by an unknown transaction");
  database.close();
});

test("reconcile keeps a mempool transaction submitted instead of declaring it ambiguous", async () => {
  const provider = new DeterministicProvider(),
    database = new DatabaseSync(":memory:"),
    sender = new DurableSender(provider as never, randomWallet(), database, options);
  provider.holdInMempool = true;
  await assert.rejects(sender.submit("slow", request), /was not included/);
  await sender.reconcile();
  assert.equal(rows(database)[0].status, "submitted");
  provider.mine();
  await sender.reconcile();
  assert.equal(rows(database)[0].status, "included");
  database.close();
});
