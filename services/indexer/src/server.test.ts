import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Interface, JsonRpcProvider, type Block, type Log, type TransactionRequest } from "ethers";
import { clearingIndexerAbi } from "../../../packages/shared/src/abi.js";
import { buildIndexer } from "./server.js";

const account = "0x0000000000000000000000000000000000000002",
  clearing = "0x0000000000000000000000000000000000000001",
  hash = "0x" + "11".repeat(32),
  tx = "0x" + "22".repeat(32),
  iface = new Interface(clearingIndexerAbi);
class Chain extends JsonRpcProvider {
  failReads = true;
  override async getBlockNumber() {
    return 10;
  }
  override async getBlock() {
    return { number: 10, hash, parentHash: "0x" + "00".repeat(32), timestamp: 1000 } as Block;
  }
  override async getLogs() {
    const event = iface.encodeEventLog(iface.getEvent("Deposited")!, [account, 100_000_000n]);
    return [
      { ...event, blockNumber: 10, blockHash: hash, transactionHash: tx, index: 0 },
    ] as unknown as Log[];
  }
  override async call(request: TransactionRequest) {
    if (this.failReads) throw new Error("injected account RPC failure");
    const decoded = iface.parseTransaction({ data: String(request.data) })!;
    return iface.encodeFunctionResult(
      decoded.name,
      decoded.name === "collateralOf" ? [100_000_000n] : [0n, 0n, 0n],
    );
  }
}

test("failed account reads cannot advance indexer checkpoint; restart recovers the deposit", async () => {
  const directory = mkdtempSync(join(tmpdir(), "rfq-index-")),
    path = join(directory, "index.sqlite"),
    provider = new Chain();
  const options = {
    rpcUrl: "http://unused",
    provider,
    clearingAddress: clearing,
    databasePath: path,
    startBlock: 10,
    confirmations: 0,
    pollMs: 60_000,
  };
  let app = buildIndexer(options);
  try {
    await app.ready();
    const db = new DatabaseSync(path);
    assert.equal(db.prepare("SELECT count(*) n FROM blocks").get()!.n, 0);
    assert.equal(db.prepare("SELECT count(*) n FROM accounts").get()!.n, 0);
    db.close();
    await app.close();
    provider.failReads = false;
    app = buildIndexer(options);
    await app.ready();
    const result = await app.inject({ method: "GET", url: `/v1/account/${account}` });
    assert.equal(result.statusCode, 200, result.body);
    assert.equal(result.json().collateral, "100000000");
    assert.equal(
      (await app.inject({ method: "GET", url: "/v1/risk?finalized=true" })).json().totalCollateral,
      "100000000",
    );
  } finally {
    await app.close();
    provider.destroy();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("database failure rolls back headers, events, accounts and finalized cursor together", async () => {
  const directory = mkdtempSync(join(tmpdir(), "rfq-index-")),
    path = join(directory, "index.sqlite"),
    provider = new Chain(),
    app = buildIndexer({
      rpcUrl: "http://unused",
      provider,
      clearingAddress: clearing,
      databasePath: path,
      startBlock: 10,
      confirmations: 0,
      pollMs: 60_000,
    });
  try {
    await app.ready();
    const db = new DatabaseSync(path);
    db.exec(
      "CREATE TRIGGER fail_accounts BEFORE INSERT ON accounts BEGIN SELECT RAISE(ABORT,'injected write failure'); END",
    );
    provider.failReads = false;
    assert.equal((await app.inject({ method: "GET", url: "/health" })).json().ok, false);
    for (const table of ["blocks", "activity", "accounts", "finalized_accounts", "metadata"])
      assert.equal(db.prepare(`SELECT count(*) n FROM ${table}`).get()!.n, 0, table);
    db.exec("DROP TRIGGER fail_accounts");
    assert.equal((await app.inject({ method: "GET", url: "/health" })).json().ok, true);
    assert.equal(db.prepare("SELECT max(number) n FROM blocks").get()!.n, 10);
    db.close();
  } finally {
    await app.close();
    provider.destroy();
    rmSync(directory, { recursive: true, force: true });
  }
});
