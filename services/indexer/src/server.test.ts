import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  Interface,
  JsonRpcProvider,
  Network,
  Wallet,
  type Block,
  type Filter,
  type FilterByBlockHash,
  type Log,
  type TransactionRequest,
} from "ethers";
import { clearingIndexerAbi } from "../../../packages/shared/src/abi.js";
import { LAUNCH_MARKETS, encodeMarketSymbol } from "../../../packages/shared/src/markets.js";
import { isolatedAccountAddress } from "../../../packages/shared/src/isolated.js";
import { buildIndexer } from "./server.js";
import { referralTypes } from "./referrals.js";

const account = "0x0000000000000000000000000000000000000002",
  clearing = "0x0000000000000000000000000000000000000001",
  hash = "0x" + "11".repeat(32),
  tx = "0x" + "22".repeat(32),
  iface = new Interface(clearingIndexerAbi);
/** Clearing view results: one deposited account without positions, and the two launch markets. */
function chainResult(name: string, args: ReadonlyArray<unknown>): unknown[] {
  if (name === "collateralOf") return [100_000_000n];
  if (name === "openMarketsOf") return [0n];
  if (name === "marketCount") return [2n];
  if (name === "marketParams") {
    const market = LAUNCH_MARKETS[Number(args[0])];
    return [[encodeMarketSymbol(market.symbol), market.impactK, market.shockBps, market.marginScaleBps]];
  }
  if (name === "markets") return [0n, 0n, 0n, 0n, 0n, 0n, true];
  return [0n, 0n, 0n];
}
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
    return iface.encodeFunctionResult(decoded.name, chainResult(decoded.name, decoded.args));
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
    for (const table of ["blocks", "activity", "accounts", "finalized_accounts", "positions"])
      assert.equal(db.prepare(`SELECT count(*) n FROM ${table}`).get()!.n, 0, table);
    assert.equal(
      db.prepare("SELECT count(*) n FROM metadata WHERE key != 'schema_version'").get()!.n,
      0,
      "metadata",
    );
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

test("sync failures are logged once per distinct error and clear on recovery", async () => {
  const directory = mkdtempSync(join(tmpdir(), "rfq-index-")),
    provider = new Chain(),
    logged: string[] = [],
    app = buildIndexer({
      rpcUrl: "http://unused",
      provider,
      clearingAddress: clearing,
      databasePath: join(directory, "index.sqlite"),
      startBlock: 10,
      confirmations: 0,
      pollMs: 60_000,
      logError: (message, error) => {
        if (message.startsWith("indexer sync failed")) logged.push(`${message} ${String(error)}`);
      },
    });
  try {
    await app.ready();
    await app.inject({ method: "GET", url: "/health" });
    assert.equal(logged.length, 1);
    assert.match(logged[0], /indexer sync failed: .*injected account RPC failure/);
    provider.failReads = false;
    assert.equal((await app.inject({ method: "GET", url: "/health" })).json().ok, true);
    assert.equal(logged.length, 1);
  } finally {
    await app.close();
    provider.destroy();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("query and path parameters are validated before reading the index", async () => {
  const directory = mkdtempSync(join(tmpdir(), "rfq-index-")),
    provider = new Chain();
  provider.failReads = false;
  const app = buildIndexer({
    rpcUrl: "http://unused",
    provider,
    clearingAddress: clearing,
    databasePath: join(directory, "index.sqlite"),
    startBlock: 10,
    confirmations: 0,
    pollMs: 60_000,
  });
  const get = (url: string) => app.inject({ method: "GET", url });
  try {
    await app.ready();
    for (const [url, error] of [
      ["/v1/account/not-an-address", "invalid account"],
      ["/v1/activity?cursor=abc", "invalid cursor"],
      ["/v1/activity?kind=Minted", "invalid activity kind"],
      ["/v1/activity?market=2", "invalid market"],
      ["/v1/positions?market=SOL", "invalid market"],
      ["/v1/positions?cursor=0x12", "invalid cursor"],
      [`/v1/account/${account}/activity?cursor=1:x`, "invalid cursor"],
      [`/v1/account/${account}/activity?exclude=TradeExecuted,Minted`, "invalid activity kind"],
    ]) {
      const response = await get(url);
      assert.equal(response.statusCode, 400, url);
      assert.equal(response.json().error, error, url);
    }
    const activity = (await get("/v1/activity?kind=Deposited&market=0&limit=500")).json();
    assert.equal(activity.items.length, 0, "Deposited has no market");
    const all = (await get(`/v1/account/${account}/activity?limit=0`)).json();
    assert.equal(all.items.length, 1);
    assert.equal(all.items[0].kind, "Deposited");
    assert.equal(all.items[0].finality, "finalized");
    const withoutTrades = (
      await get(`/v1/account/${account}/activity?exclude=TradeExecuted,FundingSettled`)
    ).json();
    assert.deepEqual(
      withoutTrades.items.map((item: { kind: string }) => item.kind),
      ["Deposited"],
    );
    const withoutDeposits = (await get(`/v1/account/${account}/activity?exclude=Deposited`)).json();
    assert.equal(withoutDeposits.items.length, 0);
    const positions = (await get("/v1/positions?finalized=false&limit=abc")).json();
    assert.equal(positions.finality, "included");
    assert.equal(positions.total, 0);
  } finally {
    await app.close();
    provider.destroy();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("update stream connections are capped per client", async () => {
  const directory = mkdtempSync(join(tmpdir(), "rfq-index-")),
    provider = new Chain();
  provider.failReads = false;
  const app = buildIndexer({
    rpcUrl: "http://unused",
    provider,
    clearingAddress: clearing,
    databasePath: join(directory, "index.sqlite"),
    startBlock: 10,
    confirmations: 0,
    pollMs: 60_000,
    maxStreamConnectionsPerClient: 1,
  });
  const controller = new AbortController();
  try {
    const url = `${await app.listen({ host: "127.0.0.1", port: 0 })}/v1/updates/stream`;
    const first = await fetch(url, { signal: controller.signal });
    assert.equal(first.status, 200);
    assert.equal(first.headers.get("access-control-allow-origin"), "http://127.0.0.1:4173");
    const reader = first.body!.getReader();
    assert.match(new TextDecoder().decode((await reader.read()).value), /event: indexed/);
    const second = await fetch(url);
    assert.equal(second.status, 429);
    assert.equal((await app.inject({ method: "GET", url: "/health" })).json().streams.active, 1);
  } finally {
    controller.abort();
    await app.close();
    provider.destroy();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("each eth_getLogs call spans at most maxLogRange blocks", async () => {
  const directory = mkdtempSync(join(tmpdir(), "rfq-index-")),
    ranges: Array<[number, number]> = [];
  class LongChain extends JsonRpcProvider {
    override async getBlockNumber() {
      return 1_200;
    }
    override async getBlock(number: unknown) {
      const height = Number(number);
      return {
        number: height,
        hash: "0x" + height.toString(16).padStart(64, "0"),
        parentHash: hash,
        timestamp: height,
      } as Block;
    }
    override async getLogs(filter: Filter | FilterByBlockHash) {
      const { fromBlock, toBlock } = filter as Filter;
      ranges.push([Number(fromBlock), Number(toBlock)]);
      return [] as Log[];
    }
  }
  const provider = new LongChain(),
    app = buildIndexer({
      rpcUrl: "http://unused",
      provider,
      clearingAddress: clearing,
      databasePath: join(directory, "index.sqlite"),
      startBlock: 1,
      confirmations: 0,
      maxLogRange: 500,
      pollMs: 60_000,
    });
  try {
    await app.ready();
    assert.ok(ranges.length > 0);
    assert.deepEqual(ranges[0], [1, 500]);
    for (const [from, to] of ranges) assert.ok(to - from + 1 <= 500, `${from}-${to}`);
  } finally {
    await app.close();
    provider.destroy();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("portfolio endpoints replay realized PnL, fees, funding and deposits from indexed events", async () => {
  const directory = mkdtempSync(join(tmpdir(), "rfq-index-")),
    E = 10n ** 18n,
    usdc = (value: bigint) => value * 1_000_000n,
    blockHash = (number: number) => "0x" + number.toString(16).padStart(64, "0"),
    log = (number: number, index: number, name: string, args: unknown[]) => ({
      ...iface.encodeEventLog(iface.getEvent(name)!, args),
      blockNumber: number,
      blockHash: blockHash(number),
      transactionHash: "0x" + (number * 100 + index).toString(16).padStart(64, "0"),
      index,
    }),
    intent = "0x" + "33".repeat(32);
  class TradingChain extends JsonRpcProvider {
    override async getBlockNumber() {
      return 12;
    }
    override async getBlock(number: unknown) {
      const height = Number(number);
      return {
        number: height,
        hash: blockHash(height),
        parentHash: hash,
        timestamp: height * 3_600,
      } as Block;
    }
    override async getLogs() {
      return [
        log(10, 0, "Deposited", [account, usdc(1_000n)]),
        log(11, 0, "TradeExecuted", [intent, account, 0, E, usdc(100n), usdc(1n)]),
        log(12, 0, "FundingSettled", [account, 0, usdc(2n)]),
        log(12, 1, "TradeExecuted", [intent, account, 0, -E / 2n, usdc(120n), usdc(1n)]),
        log(12, 2, "Liquidated", [account, 0, E / 4n, usdc(3n), 0n]),
        log(12, 3, "Withdrawn", [account, usdc(100n)]),
      ] as unknown as Log[];
    }
    override async call(request: TransactionRequest) {
      const decoded = iface.parseTransaction({ data: String(request.data) })!;
      if (decoded.name === "markets")
        return iface.encodeFunctionResult("markets", [0n, 0n, 0n, 0n, usdc(90n), usdc(91n), true]);
      return iface.encodeFunctionResult(
        decoded.name,
        decoded.name === "collateralOf" ? [usdc(905n)] : chainResult(decoded.name, decoded.args),
      );
    }
  }
  const provider = new TradingChain(),
    app = buildIndexer({
      rpcUrl: "http://unused",
      provider,
      clearingAddress: clearing,
      databasePath: join(directory, "index.sqlite"),
      startBlock: 10,
      confirmations: 1,
      pollMs: 60_000,
    });
  const get = async (url: string) => {
    const response = await app.inject({ method: "GET", url });
    assert.equal(response.statusCode, 200, `${url}: ${response.body}`);
    return response.json();
  };
  try {
    await app.ready();
    const summary = await get(`/v1/portfolio/${account}`);
    // +10 on the half closed at 120, -2.5 on the quarter liquidated at the stored bid of 90.
    assert.equal(summary.realizedPnl, (usdc(10n) - 2_500_000n).toString());
    assert.equal(summary.fees, usdc(2n).toString());
    assert.equal(summary.funding, (-usdc(2n)).toString());
    assert.equal(summary.liquidationPenalties, usdc(3n).toString());
    assert.equal(summary.netDeposits, usdc(900n).toString());
    assert.equal(summary.tradeCount, 2);
    assert.equal(summary.volume, usdc(160n).toString());
    assert.equal(summary.positions.BTC.size, (E / 4n).toString());
    assert.equal(summary.positions.BTC.entryPrice, usdc(100n).toString());
    assert.equal(summary.collateral, (usdc(900n) + usdc(10n) - 2_500_000n - usdc(7n)).toString());
    assert.equal(summary.indexedCollateral, usdc(905n).toString());
    assert.equal(summary.finality, "included");
    assert.equal(summary.indexedBlock, 12);
    assert.equal(summary.incomplete, false);

    const finalized = await get(`/v1/portfolio/${account}?finalized=true`);
    assert.equal(finalized.indexedBlock, 11);
    assert.equal(finalized.realizedPnl, "0");
    assert.equal(finalized.fees, usdc(1n).toString());

    const history = await get(`/v1/portfolio/${account}/history?interval=event`);
    assert.deepEqual(
      history.points.map((point: { timeMs: number; netDeposits: string }) => [
        point.timeMs,
        point.netDeposits,
      ]),
      [
        [36_000_000, usdc(1_000n).toString()],
        [39_600_000, usdc(1_000n).toString()],
        [43_200_000, usdc(900n).toString()],
      ],
    );
    const daily = await get(`/v1/portfolio/${account}/history?interval=1d&limit=1`);
    assert.equal(daily.points.length, 1);
    assert.equal(daily.truncated, false);
    assert.equal(daily.points[0].timeMs, 0);

    const trades = await get(`/v1/portfolio/${account}/trades?limit=2`);
    assert.deepEqual(
      trades.items.map((item: { kind: string; realizedPnl: string; finality: string }) => [
        item.kind,
        item.realizedPnl,
        item.finality,
      ]),
      [
        ["liquidation", (-2_500_000n).toString(), "included"],
        ["trade", usdc(10n).toString(), "included"],
      ],
    );
    const older = await get(`/v1/portfolio/${account}/trades?limit=2&cursor=${trades.nextCursor}`);
    assert.equal(older.items.length, 1);
    assert.equal(older.items[0].finality, "finalized");
    assert.equal(older.nextCursor, null);

    const funding = await get(`/v1/funding/${account}?market=BTC`);
    assert.equal(funding.items.length, 1);
    assert.equal(funding.items[0].market, "BTC");
    assert.equal(funding.items[0].payment, usdc(2n).toString());
    assert.equal(funding.items[0].amount, (-usdc(2n)).toString());
    assert.equal(funding.totalFunding, (-usdc(2n)).toString());
    assert.equal((await get(`/v1/funding/${account}?market=ETH`)).items.length, 0);

    for (const [url, error] of [
      ["/v1/portfolio/0x12", "invalid account"],
      [`/v1/portfolio/${account}/history?interval=5m`, "invalid interval"],
      [`/v1/portfolio/${account}/trades?market=SOL`, "invalid market"],
      [`/v1/funding/${account}?cursor=x`, "invalid cursor"],
    ]) {
      const response = await app.inject({ method: "GET", url });
      assert.equal(response.statusCode, 400, url);
      assert.equal(response.json().error, error, url);
    }
    const empty = await get(`/v1/portfolio/${clearing}`);
    assert.equal(empty.tradeCount, 0);
    assert.equal(empty.indexedCollateral, null);
  } finally {
    await app.close();
    provider.destroy();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("leaderboard ranks owners with their isolated accounts, and points sum trade volume", async () => {
  const directory = mkdtempSync(join(tmpdir(), "rfq-index-")),
    E = 10n ** 18n,
    usdc = (value: bigint) => value * 1_000_000n,
    referee = Wallet.createRandom(),
    other = referee.address,
    isolated = isolatedAccountAddress(account, 0),
    blockHash = (number: number) => "0x" + number.toString(16).padStart(64, "0"),
    log = (number: number, index: number, name: string, args: unknown[]) => ({
      ...iface.encodeEventLog(iface.getEvent(name)!, args),
      blockNumber: number,
      blockHash: blockHash(number),
      transactionHash: "0x" + (number * 100 + index).toString(16).padStart(64, "0"),
      index,
    }),
    intent = "0x" + "33".repeat(32);
  class LeaderboardChain extends JsonRpcProvider {
    override async getNetwork() {
      return new Network("test", 31_337n);
    }
    override async getCode() {
      return "0x";
    }
    override async getBlockNumber() {
      return 40;
    }
    override async getBlock(number: unknown) {
      const height = Number(number);
      return {
        number: height,
        hash: blockHash(height),
        parentHash: hash,
        timestamp: height * 3_600,
      } as Block;
    }
    override async getLogs() {
      return [
        log(10, 0, "MarginTransferred", [account, isolated, 0, -usdc(500n)]),
        log(10, 1, "MarginTransferred", [isolated, account, 0, usdc(500n)]),
        // Two days before the newest block: inside 7d, outside 1d.
        log(10, 2, "TradeExecuted", [intent, isolated, 0, E, usdc(300n), 0n]),
        log(39, 0, "TradeExecuted", [intent, account, 0, E, usdc(100n), 0n]),
        log(40, 0, "TradeExecuted", [intent, other, 0, 2n * E, usdc(1_500n), 0n]),
      ] as unknown as Log[];
    }
    override async call(request: TransactionRequest) {
      const decoded = iface.parseTransaction({ data: String(request.data) })!;
      return iface.encodeFunctionResult(decoded.name, chainResult(decoded.name, decoded.args));
    }
  }
  const provider = new LeaderboardChain(),
    app = buildIndexer({
      rpcUrl: "http://unused",
      provider,
      clearingAddress: clearing,
      databasePath: join(directory, "index.sqlite"),
      startBlock: 10,
      confirmations: 0,
      pollMs: 60_000,
    });
  const get = async (url: string) => {
    const response = await app.inject({ method: "GET", url });
    assert.equal(response.statusCode, 200, `${url}: ${response.body}`);
    return response.json();
  };
  try {
    await app.ready();
    const week = await get("/v1/leaderboard?window=7d");
    assert.deepEqual(
      week.traders.map((row: { account: string; volume: string }) => [row.account, row.volume]),
      [
        [other, usdc(3_000n).toString()],
        [account, usdc(400n).toString()],
      ],
    );
    // The isolated account's trade two days ago falls outside the last day.
    const day = await get("/v1/leaderboard?window=1d");
    assert.deepEqual(
      day.traders.map((row: { account: string; volume: string }) => [row.account, row.volume]),
      [
        [other, usdc(3_000n).toString()],
        [account, usdc(100n).toString()],
      ],
    );
    const points = await get(`/v1/points/${account}`);
    assert.deepEqual(points.accounts, [account, isolated]);
    assert.equal(points.total, "4");
    assert.equal(points.referralPoints, "0");

    // The referee binds the account as its referrer; the referrer then earns 10% of the referee's points.
    const issuedAt = Math.floor(Date.now() / 1_000),
      referral = { account: other, referrer: account, issuedAt },
      signature = await referee.signTypedData(
        { name: "RFQ Markets", version: "1", chainId: 31_337n, verifyingContract: clearing },
        referralTypes,
        referral,
      ),
      post = (body: unknown) => app.inject({ method: "POST", url: "/v1/referrals", payload: body as object });
    assert.equal((await post({ ...referral, signature })).statusCode, 200);
    assert.equal((await post({ ...referral, signature })).statusCode, 200, "idempotent");
    const forged = await Wallet.createRandom().signTypedData(
      { name: "RFQ Markets", version: "1", chainId: 31_337n, verifyingContract: clearing },
      referralTypes,
      { ...referral, referrer: other },
    );
    assert.equal((await post({ ...referral, referrer: clearing, signature: forged })).statusCode, 401);
    assert.equal((await post({ ...referral, referrer: other, signature })).statusCode, 400, "self");
    assert.equal((await post({ ...referral, issuedAt: issuedAt - 3_600, signature })).statusCode, 400);
    const rebind = await referee.signTypedData(
      { name: "RFQ Markets", version: "1", chainId: 31_337n, verifyingContract: clearing },
      referralTypes,
      { ...referral, referrer: clearing },
    );
    assert.equal((await post({ ...referral, referrer: clearing, signature: rebind })).statusCode, 409);
    assert.deepEqual(await get(`/v1/referrals/${account}`), { account, referrer: null, referees: [other] });
    assert.equal((await get(`/v1/referrals/${other}`)).referrer, account);
    const referred = await get(`/v1/points/${account}`);
    assert.equal(referred.referees, 1);
    assert.equal(referred.referralPoints, "3");
    assert.equal(referred.totalWithReferrals, "7");

    // An isolated account trades on its owner's tier; these 1970 fills are outside today's 14-day window.
    const fees = await get(`/v1/fees/${isolated}`);
    assert.equal(fees.owner, account);
    assert.deepEqual(fees.accounts, [account, isolated]);
    assert.equal(fees.volume, "0");
    assert.equal(fees.tier, 0);
    assert.equal(fees.nextTier.tier, 1);
    assert.equal(fees.windowEndMs - fees.windowStartMs, 14 * 86_400_000);
    for (const url of ["/v1/leaderboard?window=2d", "/v1/leaderboard?sort=fees", "/v1/points/0x12"])
      assert.equal((await app.inject({ method: "GET", url })).statusCode, 400, url);
  } finally {
    await app.close();
    provider.destroy();
    rmSync(directory, { recursive: true, force: true });
  }
});
