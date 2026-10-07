import Fastify, { type FastifyReply } from "fastify";
import cors from "@fastify/cors";
import { DatabaseSync } from "node:sqlite";
import { Contract, Interface, JsonRpcProvider, getAddress, type Log } from "ethers";
import { z } from "zod";
import { clearingIndexerAbi } from "../../../packages/shared/src/abi.js";
import { ConnectionBudget } from "../../../packages/shared/src/connection-budget.js";
import {
  MAX_MARKETS,
  isKnownMarket,
  marketIndex,
  marketRefreshIntervalMs,
  marketRegistry,
  watchMarketRegistry,
  type MarketRegistryWatch,
} from "../../../packages/shared/src/markets.js";
import { SseClients, openSse, sseFrame } from "../../lib/src/sse.js";
import { RiskProjection, marketLabel } from "./risk-projection.js";
import {
  HISTORY_INTERVALS,
  bucketPoints,
  replayPortfolio,
  type HistoryInterval,
  type PortfolioEvent,
  type PortfolioReplay,
} from "./portfolio.js";
import {
  LEADERBOARD_WINDOWS,
  mergeByOwner,
  rankTraders,
  weeklyPoints,
  windowStats,
  type LeaderboardWindow,
  type WindowStats,
} from "./leaderboard.js";
import { isolatedAccountAddress } from "../../../packages/shared/src/isolated.js";
import { validOwnerSignature } from "../../api/src/owner-signature.js";
import { referralBonus, referralDigest, referralTermsError } from "./referrals.js";

export interface IndexerOptions {
  rpcUrl: string;
  clearingAddress: string;
  databasePath: string;
  startBlock?: number;
  confirmations?: number;
  /** Most blocks one eth_getLogs call may span; public Base RPCs cap this well below the default 10,000. */
  maxLogRange?: number;
  /** RPC for the direct contract reads behind /v1/exposure; defaults to rpcUrl. Lets the hedger's hot path
   * use a faster provider than the one with the wide eth_getLogs range. */
  readRpcUrl?: string;
  pollMs?: number;
  corsOrigin?: string | string[];
  provider?: JsonRpcProvider;
  /** Update-stream connection caps (global and per client IP). */
  maxStreamConnections?: number;
  maxStreamConnectionsPerClient?: number;
  /** Where sync failures are reported; defaults to stderr. Each distinct failure is logged once. */
  logError?: (message: string, error: unknown) => void;
  /** Market registry refresh interval (default 60 s; `RFQ_MARKET_REFRESH_MS`). */
  marketRefreshMs?: number;
}

/** Bumped when the tables change shape; an older database is dropped and reindexed from `startBlock`. */
const SCHEMA_VERSION = "2";

const ACTIVITY_KINDS = [
  "Deposited",
  "Withdrawn",
  "MarginTransferred",
  "NonceCancelled",
  "SessionGranted",
  "SessionRevoked",
  "TradeExecuted",
  "FundingSettled",
  "PositionClosed",
  "Liquidated",
  "DeficitAbsorbed",
  "MakerWithdrawn",
  "EpochAdvanced",
  "ResolutionStarted",
  "ResolutionPriceReady",
  "ResolutionFinalized",
] as const;
const address = (message: string) =>
  z.string().transform((value, context) => {
    try {
      return getAddress(value);
    } catch {
      context.addIssue({ code: z.ZodIssueCode.custom, message });
      return z.NEVER;
    }
  });
/** Page size: invalid values fall back, valid ones are clamped to 1..100. */
const pageLimit = (fallback: number) =>
  z.coerce
    .number()
    .int()
    .catch(fallback)
    .transform((value) => Math.min(100, Math.max(1, value)));
/** "block:logIndex" of the last item already seen; omitted means "from the newest". */
const activityCursor = z
  .string()
  .regex(/^\d+:\d+$/, "invalid cursor")
  .transform((value) => value.split(":").map(Number) as [number, number])
  .refine((parts) => parts.every(Number.isSafeInteger), "invalid cursor")
  .default(`${Number.MAX_SAFE_INTEGER}:${Number.MAX_SAFE_INTEGER}`);
const isTrue = z
  .string()
  .optional()
  .transform((value) => value === "true");
const accountParams = z.object({ address: address("invalid account") });
/** Comma-separated kinds to leave out, e.g. `TradeExecuted,FundingSettled` when those have their own views. */
const excludedKinds = z
  .string()
  .optional()
  .transform((value) => (value ? value.split(",") : []))
  .pipe(z.array(z.enum(ACTIVITY_KINDS, { message: "invalid activity kind" })).max(ACTIVITY_KINDS.length));
const accountActivityQuery = z.object({
  cursor: activityCursor,
  limit: pageLimit(25),
  exclude: excludedKinds,
});
const activityQuery = z.object({
  cursor: activityCursor,
  limit: pageLimit(25),
  kind: z.enum(ACTIVITY_KINDS, { message: "invalid activity kind" }).optional(),
  market: z
    .string()
    .regex(/^\d{1,3}$/, "invalid market")
    .transform(Number)
    .refine((value) => value < MAX_MARKETS && marketRegistry.hasIndex(value), "invalid market")
    .optional(),
  finalized: isTrue,
});
const finalityQuery = z.object({ finalized: isTrue });
/** A registered market symbol (the registry refreshes from chain). */
const knownMarket = z.string().refine(isKnownMarket, "invalid market");
const fillMarket = knownMarket.optional();
const portfolioHistoryQuery = z.object({
  interval: z
    .enum(Object.keys(HISTORY_INTERVALS) as [HistoryInterval, ...HistoryInterval[]], {
      message: "invalid interval",
    })
    .default("event"),
  limit: z.coerce
    .number()
    .int()
    .catch(500)
    .transform((value) => Math.min(2_000, Math.max(1, value))),
  finalized: isTrue,
});
const portfolioPageQuery = z.object({
  cursor: activityCursor,
  limit: pageLimit(25),
  market: fillMarket,
  finalized: isTrue,
});
const leaderboardQuery = z.object({
  window: z
    .enum(Object.keys(LEADERBOARD_WINDOWS) as [LeaderboardWindow, ...LeaderboardWindow[]], {
      message: "invalid window",
    })
    .default("7d"),
  sort: z.enum(["volume", "pnl"], { message: "invalid sort" }).default("volume"),
  limit: pageLimit(50),
  finalized: isTrue,
});
const referralBody = z.object({
  account: address("invalid account"),
  referrer: address("invalid referrer"),
  issuedAt: z.number().int().nonnegative(),
  signature: z.string().regex(/^0x[0-9a-fA-F]{130,}$/, "invalid signature"),
});
/** Replays kept per (account, finality, indexed block); each request after a new block replays again. */
const PORTFOLIO_CACHE_SIZE = 256;
const positionsQuery = z.object({
  limit: pageLimit(50),
  // Finalized unless explicitly asked for included state.
  finalized: z
    .string()
    .optional()
    .transform((value) => value !== "false"),
  market: knownMarket.optional(),
  cursor: address("invalid cursor").optional(),
});

export function buildIndexer(options: IndexerOptions) {
  const corsOrigins = options.corsOrigin ?? ["http://127.0.0.1:4173", "http://127.0.0.1:4174"],
    streamBudget = new ConnectionBudget(
      options.maxStreamConnections ?? 1_000,
      options.maxStreamConnectionsPerClient ?? 8,
    ),
    logError = options.logError ?? ((message: string, error: unknown) => console.error(message, error));
  // The first finalized sync can span the full deployment history and depends
  // on public RPC latency. Keep Fastify's startup watchdog above the ordinary
  // ten-second plugin default while retaining a finite failure boundary.
  const app = Fastify({ logger: false, pluginTimeout: 60_000 });
  app.register(cors, { origin: corsOrigins });
  const provider = options.provider ?? new JsonRpcProvider(options.rpcUrl, undefined, { batchMaxCount: 1 });
  const contract = new Contract(options.clearingAddress, clearingIndexerAbi, provider);
  const readProvider =
      options.readRpcUrl && !options.provider
        ? new JsonRpcProvider(options.readRpcUrl, undefined, { batchMaxCount: 1 })
        : provider,
    readContract = new Contract(options.clearingAddress, clearingIndexerAbi, readProvider);
  const iface = new Interface(clearingIndexerAbi);
  const db = new DatabaseSync(options.databasePath);
  db.exec(
    "PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL)",
  );
  // Schema 1 kept one column pair per launch market (btc_size, eth_size). Positions now live in their own
  // table keyed by market index, so an older database is dropped and rebuilt from chain.
  const schema = db.prepare("SELECT value FROM metadata WHERE key='schema_version'").get() as
    { value: string } | undefined;
  if (schema?.value !== SCHEMA_VERSION) {
    db.exec(
      "DROP TABLE IF EXISTS blocks; DROP TABLE IF EXISTS activity; DROP TABLE IF EXISTS accounts; DROP TABLE IF EXISTS finalized_accounts; DROP TABLE IF EXISTS positions; DROP TABLE IF EXISTS finalized_positions; DROP TABLE IF EXISTS liquidation_marks; DELETE FROM metadata",
    );
    db.prepare("INSERT INTO metadata VALUES('schema_version',?)").run(SCHEMA_VERSION);
  }
  // Referrals are signed by users, not read from chain, so neither a reindex nor a schema bump drops them.
  db.exec(
    "CREATE TABLE IF NOT EXISTS referrals(account TEXT PRIMARY KEY,referrer TEXT NOT NULL,issued_at INTEGER NOT NULL,signature TEXT NOT NULL,created_ms INTEGER NOT NULL); CREATE INDEX IF NOT EXISTS referrals_referrer ON referrals(referrer)",
  );
  db.exec(
    "CREATE TABLE IF NOT EXISTS blocks(number INTEGER PRIMARY KEY,hash TEXT NOT NULL,parent_hash TEXT NOT NULL,timestamp INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS activity(tx_hash TEXT NOT NULL,log_index INTEGER NOT NULL,block_number INTEGER NOT NULL,block_hash TEXT NOT NULL,timestamp INTEGER NOT NULL,kind TEXT NOT NULL,account TEXT,market INTEGER,payload TEXT NOT NULL,PRIMARY KEY(tx_hash,log_index)); CREATE INDEX IF NOT EXISTS activity_account_block ON activity(account,block_number DESC,log_index DESC); CREATE TABLE IF NOT EXISTS accounts(account TEXT PRIMARY KEY,collateral TEXT NOT NULL,indexed_block INTEGER NOT NULL,indexed_tx TEXT); CREATE TABLE IF NOT EXISTS finalized_accounts(account TEXT PRIMARY KEY,collateral TEXT NOT NULL,indexed_block INTEGER NOT NULL,indexed_tx TEXT); CREATE TABLE IF NOT EXISTS positions(account TEXT NOT NULL,market INTEGER NOT NULL,size TEXT NOT NULL,entry TEXT NOT NULL,PRIMARY KEY(account,market)); CREATE TABLE IF NOT EXISTS finalized_positions(account TEXT NOT NULL,market INTEGER NOT NULL,size TEXT NOT NULL,entry TEXT NOT NULL,PRIMARY KEY(account,market)); CREATE INDEX IF NOT EXISTS positions_market ON positions(market,account); CREATE INDEX IF NOT EXISTS finalized_positions_market ON finalized_positions(market,account); CREATE TABLE IF NOT EXISTS liquidation_marks(tx_hash TEXT NOT NULL,log_index INTEGER NOT NULL,bid TEXT NOT NULL,ask TEXT NOT NULL,PRIMARY KEY(tx_hash,log_index))",
  );
  /** Accounts and their position tables, live (included) or finalized. */
  const tables = (finalized: boolean) =>
    finalized
      ? ({ accounts: "finalized_accounts", positions: "finalized_positions" } as const)
      : ({ accounts: "accounts", positions: "positions" } as const);
  /** Open positions per account, by market index. */
  function storedPositions(finalized: boolean, accounts: string[]) {
    const result = new Map<string, Map<number, { size: string; entry: string }>>();
    if (!accounts.length) return result;
    const rows = db
      .prepare(
        `SELECT account,market,size,entry FROM ${tables(finalized).positions} WHERE account IN (${accounts.map(() => "?").join(",")})`,
      )
      .all(...accounts) as Array<{ account: string; market: number; size: string; entry: string }>;
    for (const row of rows) {
      let positions = result.get(row.account);
      if (!positions) result.set(row.account, (positions = new Map()));
      positions.set(Number(row.market), { size: row.size, entry: row.entry });
    }
    return result;
  }
  /** `{ [symbol]: { size, entryPrice } }` for every registered market and any other open one. */
  function positionView(positions: Map<number, { size: string; entry: string }> | undefined) {
    const indexes = new Set([
      ...marketRegistry.all().map((market) => market.index),
      ...(positions?.keys() ?? []),
    ]);
    return Object.fromEntries(
      [...indexes]
        .sort((left, right) => left - right)
        .map((index) => {
          const position = positions?.get(index);
          return [marketLabel(index), { size: position?.size ?? "0", entryPrice: position?.entry ?? "0" }];
        }),
    );
  }
  const portfolioCache = new Map<string, PortfolioReplay>();
  const liveRisk = new RiskProjection(),
    finalizedRisk = new RiskProjection();
  for (const [finalized, risk] of [
    [false, liveRisk],
    [true, finalizedRisk],
  ] as const) {
    const rows = db.prepare(`SELECT account,collateral FROM ${tables(finalized).accounts}`).all() as Array<{
        account: string;
        collateral: string;
      }>,
      positions = db
        .prepare(`SELECT account,market,size FROM ${tables(finalized).positions}`)
        .all() as Array<{
        account: string;
        market: number;
        size: string;
      }>,
      sizes = new Map<string, Map<number, string>>();
    for (const row of positions) {
      let map = sizes.get(row.account);
      if (!map) sizes.set(row.account, (map = new Map()));
      map.set(Number(row.market), row.size);
    }
    for (const row of rows) risk.update({ ...row, sizes: sizes.get(row.account) ?? new Map() });
  }
  let registryWatch: MarketRegistryWatch | undefined;
  let syncing: Promise<{ accounts: Set<string>; reset: boolean }> | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let lastError: string | undefined,
    lastPublishedBlock = -1;
  const updateClients = new SseClients();
  function indexedBlock() {
    return (
      (db.prepare("SELECT max(number) value FROM blocks").get() as { value: number | null }).value ??
      (options.startBlock ?? 0) - 1
    );
  }
  function publishUpdate(accounts: Set<string>, reset = false) {
    const block = indexedBlock();
    if (block === lastPublishedBlock && !accounts.size && !reset) return;
    lastPublishedBlock = block;
    updateClients.broadcast(
      sseFrame("indexed", {
        indexedBlock: block,
        changed: accounts.size > 0 || reset,
        reset,
        accounts: [...accounts],
      }),
    );
  }
  function atomic(write: () => void) {
    db.exec("BEGIN IMMEDIATE");
    try {
      write();
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
  const reset = () => {
    atomic(() =>
      db.exec(
        "DELETE FROM blocks; DELETE FROM activity; DELETE FROM accounts; DELETE FROM finalized_accounts; DELETE FROM positions; DELETE FROM finalized_positions; DELETE FROM metadata WHERE key != 'schema_version'; DELETE FROM liquidation_marks",
      ),
    );
    liveRisk.clear();
    finalizedRisk.clear();
    portfolioCache.clear();
  };
  /** Collateral and every open position (`openMarketsOf` bit i = market i) at `blockTag`. */
  async function readAccount(account: string, blockTag: number, txHash?: string) {
    const [collateral, openMask] = await Promise.all([
      contract.collateralOf(account, { blockTag }),
      contract.openMarketsOf(account, { blockTag }),
    ]);
    const open: number[] = [];
    for (let index = 0, mask = BigInt(openMask); mask !== 0n; index++, mask >>= 1n)
      if (mask & 1n) open.push(index);
    const positions = await Promise.all(
      open.map(async (market) => {
        const position = await contract.positionOf(account, market, { blockTag });
        return { market, size: position.size.toString(), entry: position.entryPrice.toString() };
      }),
    );
    return {
      account,
      collateral: collateral.toString(),
      positions: positions.filter((position) => position.size !== "0"),
      blockTag,
      txHash,
    };
  }
  type AccountRow = Awaited<ReturnType<typeof readAccount>>;
  const projection = (row: AccountRow) => ({
    account: row.account,
    collateral: row.collateral,
    sizes: new Map(row.positions.map((position) => [position.market, position.size])),
  });
  function writeAccount(row: AccountRow, finalized: boolean) {
    const table = tables(finalized);
    db.prepare(
      `INSERT INTO ${table.accounts} VALUES(?,?,?,?) ON CONFLICT(account) DO UPDATE SET collateral=excluded.collateral,indexed_block=excluded.indexed_block,indexed_tx=excluded.indexed_tx`,
    ).run(row.account, row.collateral, row.blockTag, row.txHash ?? null);
    db.prepare(`DELETE FROM ${table.positions} WHERE account=?`).run(row.account);
    for (const position of row.positions)
      db.prepare(`INSERT INTO ${table.positions} VALUES(?,?,?,?)`).run(
        row.account,
        position.market,
        position.size,
        position.entry,
      );
  }
  async function stageFinalized(
    head: number,
    tip = indexedBlock(),
    newAccounts: Array<{ account: string; block: number }> = [],
  ) {
    const target = Math.min(
        tip,
        Math.max((options.startBlock ?? 0) - 1, head - (options.confirmations ?? 2)),
      ),
      stored = Number(
        (
          db.prepare("SELECT value FROM metadata WHERE key='finalized_cursor'").get() as
            { value: string } | undefined
        )?.value ?? (options.startBlock ?? 0) - 1,
      );
    if (target <= stored) return undefined;
    const affected = new Set(
      (
        db
          .prepare(
            "SELECT DISTINCT account FROM activity WHERE account IS NOT NULL AND block_number>? AND block_number<=?",
          )
          .all(stored, target) as Array<{ account: string }>
      ).map((row) => row.account),
    );
    for (const row of newAccounts) if (row.block > stored && row.block <= target) affected.add(row.account);
    const rows = await Promise.all([...affected].map((account) => readAccount(account, target)));
    return { target, rows };
  }
  function writeFinalized(stage: Awaited<ReturnType<typeof stageFinalized>>) {
    if (!stage) return;
    for (const row of stage.rows) writeAccount(row, true);
    db.prepare(
      "INSERT INTO metadata VALUES('finalized_cursor',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
    ).run(String(stage.target));
  }
  async function syncPass() {
    const head = await provider.getBlockNumber();
    let row = db.prepare("SELECT number,hash FROM blocks ORDER BY number DESC LIMIT 1").get() as
      { number: number; hash: string } | undefined;
    let rebuilt = false;
    if (row) {
      const canonical = await provider.getBlock(row.number);
      if (!canonical || canonical.hash !== row.hash) {
        reset();
        row = undefined;
        rebuilt = true;
      }
    }
    const from = Math.max(options.startBlock ?? 0, (row?.number ?? (options.startBlock ?? 0) - 1) + 1);
    if (from > head) {
      const finalized = await stageFinalized(head);
      atomic(() => writeFinalized(finalized));
      for (const item of finalized?.rows ?? []) finalizedRisk.update(projection(item));
      return { accounts: new Set<string>(), reset: rebuilt };
    }
    // Stage every network read before opening a synchronous transaction. A failed
    // read or crash cannot advance the checkpoint past incomplete projections.
    const to = Math.min(head, from + (options.maxLogRange ?? 10_000) - 1),
      logs = await provider.getLogs({ address: options.clearingAddress, fromBlock: from, toBlock: to }),
      affected = new Map<string, { tx: string; block: number }>(),
      numbers = [...new Set([...logs.map((log) => log.blockNumber), to])],
      headers = await Promise.all(numbers.map((number) => provider.getBlock(number))),
      timestamps = new Map<number, number>();
    for (const block of headers) {
      if (!block?.hash) throw new Error("missing canonical header");
      timestamps.set(block.number, block.timestamp);
    }
    const events: Array<{
      log: Log;
      timestamp: number;
      kind: string;
      account: string | null;
      market: number | null;
      payload: string;
    }> = [];
    for (const log of logs) {
      let parsed;
      try {
        parsed = iface.parseLog(log);
      } catch {
        continue; // proxy/admin events from the same address are not part of the read model
      }
      if (!parsed) continue;
      const timestamp = timestamps.get(log.blockNumber);
      if (timestamp === undefined) throw new Error(`missing block ${log.blockNumber}`);
      if (headers.find((header) => header?.number === log.blockNumber)?.hash !== log.blockHash)
        throw new Error("log/header divergence");
      const account = parsed.args.account ? getAddress(parsed.args.account) : null,
        market = parsed.args.market === undefined ? null : Number(parsed.args.market),
        payload = JSON.stringify(parsed.args.toObject(), (_, value) =>
          typeof value === "bigint" ? value.toString() : value,
        );
      events.push({ log, timestamp, kind: parsed.name, account, market, payload });
      if (account) affected.set(account, { tx: log.transactionHash, block: log.blockNumber });
    }
    const included = await Promise.all(
      [...affected].map(([account, event]) => readAccount(account, event.block, event.tx)),
    );
    // A partial liquidation emits no fill price. Keep the oracle side stored at the end of its block so the
    // portfolio replay can price the closed size (exact when the block holds one price update for the market).
    const marks = await Promise.all(
      events
        .filter((event) => event.kind === "Liquidated" && event.market !== null)
        .map(async (event) => {
          const state = await contract.markets(event.market!, { blockTag: event.log.blockNumber });
          return {
            tx: event.log.transactionHash,
            index: event.log.index,
            bid: state.lastBid.toString(),
            ask: state.lastAsk.toString(),
          };
        }),
    );
    const finalized = await stageFinalized(
      head,
      to,
      events
        .filter((event) => event.account)
        .map((event) => ({ account: event.account!, block: event.log.blockNumber })),
    );
    const tip = headers.find((header) => header?.number === to),
      canonical = await provider.getBlock(to);
    if (!tip || canonical?.hash !== tip.hash) throw new Error("chain changed before checkpoint commit");
    atomic(() => {
      for (const block of headers)
        db.prepare("INSERT OR REPLACE INTO blocks VALUES(?,?,?,?)").run(
          block!.number,
          block!.hash,
          block!.parentHash,
          block!.timestamp,
        );
      for (const { log, timestamp, kind, account, market, payload } of events)
        db.prepare("INSERT OR REPLACE INTO activity VALUES(?,?,?,?,?,?,?,?,?)").run(
          log.transactionHash,
          log.index,
          log.blockNumber,
          log.blockHash,
          timestamp,
          kind,
          account,
          market,
          payload,
        );
      for (const mark of marks)
        db.prepare("INSERT OR REPLACE INTO liquidation_marks VALUES(?,?,?,?)").run(
          mark.tx,
          mark.index,
          mark.bid,
          mark.ask,
        );
      for (const item of included) writeAccount(item, false);
      writeFinalized(finalized);
    });
    for (const item of included) liveRisk.update(projection(item));
    for (const item of finalized?.rows ?? []) finalizedRisk.update(projection(item));
    return { accounts: new Set(affected.keys()), reset: rebuilt };
  }
  async function doSync() {
    for (let attempt = 0; attempt < 3; attempt++) {
      const result = await syncPass();
      const row = db.prepare("SELECT number,hash FROM blocks ORDER BY number DESC LIMIT 1").get() as
        { number: number; hash: string } | undefined;
      if (!row) return result;
      const canonical = await provider.getBlock(row.number);
      if (canonical?.hash === row.hash) return result;
      reset();
    }
    throw new Error("chain changed during three consecutive index passes");
  }
  async function sync() {
    if (syncing) return syncing;
    syncing = doSync()
      .then((result) => {
        lastError = undefined;
        publishUpdate(result.accounts, result.reset);
        return result;
      })
      .catch((error) => {
        const message = String(error);
        if (message !== lastError) logError("indexer sync failed:", error);
        lastError = message;
        return { accounts: new Set<string>(), reset: false };
      })
      .finally(() => {
        syncing = undefined;
      });
    return syncing;
  }
  const finalizedCursor = () =>
    Number(
      (
        db.prepare("SELECT value FROM metadata WHERE key='finalized_cursor'").get() as
          { value: string } | undefined
      )?.value ?? (options.startBlock ?? 0) - 1,
    );
  const finalityBlock = async () =>
    Math.max((options.startBlock ?? 0) - 1, (await provider.getBlockNumber()) - (options.confirmations ?? 2));
  /** Parses a query or params object; on failure replies 400 with the first issue and returns undefined. */
  const parse = <T extends z.ZodTypeAny>(schema: T, value: unknown, reply: FastifyReply) => {
    const result = schema.safeParse(value);
    if (result.success) return result.data as z.output<T>;
    void reply.code(400).send({ error: result.error.issues[0]?.message ?? "invalid request" });
    return undefined;
  };
  const activityPage = (rows: Array<Record<string, string | number>>, limit: number, finalized: number) => ({
    items: rows.map((row) => ({
      ...row,
      payload: JSON.parse(String(row.payload)),
      finality: Number(row.block_number) <= finalized ? "finalized" : "included",
    })),
    nextCursor:
      rows.length === limit
        ? `${rows[rows.length - 1].block_number}:${rows[rows.length - 1].log_index}`
        : null,
  });

  app.get("/health", async () => {
    await sync();
    const head = await provider.getBlockNumber(),
      indexed = indexedBlock(),
      finalized = Math.max((options.startBlock ?? 0) - 1, head - (options.confirmations ?? 2));
    return {
      ok: !lastError,
      indexedBlock: indexed,
      finalizedBlock: Math.min(indexed, finalized),
      headBlock: head,
      lag: head - indexed,
      error: lastError ? "index_sync_failed" : undefined,
      streams: streamBudget.status(),
    };
  });
  app.get("/v1/updates/stream", async (request, reply) => {
    const release = streamBudget.acquire(request.ip);
    if (!release)
      return reply.code(429).header("retry-after", "5").send({ error: "stream connection limit reached" });
    const response = openSse(reply, corsOrigins);
    response.once("close", release);
    updateClients.add(response);
    updateClients.send(
      response,
      sseFrame("indexed", { indexedBlock: indexedBlock(), changed: true, initial: true, accounts: [] }),
    );
  });
  app.get("/v1/account/:address", async (request, reply) => {
    await sync();
    const params = parse(accountParams, request.params, reply);
    if (!params) return;
    const row = db.prepare("SELECT * FROM accounts WHERE account=?").get(params.address) as
      Record<string, string | number> | undefined;
    if (!row) return reply.code(404).send({ error: "account not indexed" });
    return {
      account: params.address,
      collateral: row.collateral,
      positions: positionView(storedPositions(false, [params.address]).get(params.address)),
      indexedBlock: row.indexed_block,
      indexedTransaction: row.indexed_tx,
    };
  });
  app.get("/v1/account/:address/activity", async (request, reply) => {
    await sync();
    const params = parse(accountParams, request.params, reply),
      query = params && parse(accountActivityQuery, request.query, reply);
    if (!params || !query) return;
    const [cursorBlock, cursorLog] = query.cursor;
    const excluded = query.exclude.length
      ? ` AND kind NOT IN (${query.exclude.map(() => "?").join(",")})`
      : "";
    const rows = db
      .prepare(
        `SELECT * FROM activity WHERE account=? AND (block_number<? OR (block_number=? AND log_index<?))${excluded} ORDER BY block_number DESC,log_index DESC LIMIT ?`,
      )
      .all(params.address, cursorBlock, cursorBlock, cursorLog, ...query.exclude, query.limit) as Array<
      Record<string, string | number>
    >;
    return activityPage(rows, query.limit, await finalityBlock());
  });
  app.get("/v1/activity", async (request, reply) => {
    await sync();
    const query = parse(activityQuery, request.query, reply);
    if (!query) return;
    const [cursorBlock, cursorLog] = query.cursor,
      finalized = await finalityBlock();
    const clauses = ["(block_number<? OR (block_number=? AND log_index<?))"],
      params: Array<string | number> = [cursorBlock, cursorBlock, cursorLog];
    if (query.finalized) {
      clauses.push("block_number<=?");
      params.push(finalized);
    }
    if (query.kind) {
      clauses.push("kind=?");
      params.push(query.kind);
    }
    if (query.market !== undefined) {
      clauses.push("market=?");
      params.push(query.market);
    }
    const rows = db
      .prepare(
        `SELECT * FROM activity WHERE ${clauses.join(" AND ")} ORDER BY block_number DESC,log_index DESC LIMIT ?`,
      )
      .all(...params, query.limit) as Array<Record<string, string | number>>;
    return { ...activityPage(rows, query.limit, finalized), finalizedBlock: finalized };
  });
  /** The account's replayed portfolio up to `throughBlock`, cached per indexed block. */
  function portfolio(account: string, throughBlock: number, finalized: boolean) {
    const key = `${account}:${finalized ? "finalized" : "included"}:${throughBlock}`,
      cached = portfolioCache.get(key);
    if (cached) return cached;
    const rows = db
      .prepare(
        "SELECT a.tx_hash,a.log_index,a.block_number,a.timestamp,a.kind,a.payload,m.bid,m.ask FROM activity a LEFT JOIN liquidation_marks m ON m.tx_hash=a.tx_hash AND m.log_index=a.log_index WHERE a.account=? AND a.block_number<=? ORDER BY a.block_number,a.log_index",
      )
      .all(account, throughBlock) as Array<{
      tx_hash: string;
      log_index: number;
      block_number: number;
      timestamp: number;
      kind: string;
      payload: string;
      bid: string | null;
      ask: string | null;
    }>;
    const events: PortfolioEvent[] = rows.map((row) => ({
      txHash: row.tx_hash,
      logIndex: row.log_index,
      blockNumber: row.block_number,
      timestamp: row.timestamp,
      kind: row.kind,
      payload: JSON.parse(row.payload) as Record<string, string>,
      liquidationMark:
        row.bid !== null && row.ask !== null ? { bid: BigInt(row.bid), ask: BigInt(row.ask) } : undefined,
    }));
    const replay = replayPortfolio(events);
    if (portfolioCache.size >= PORTFOLIO_CACHE_SIZE)
      portfolioCache.delete(portfolioCache.keys().next().value!);
    portfolioCache.set(key, replay);
    return replay;
  }
  /** Indexed and finalized heights, and the height a portfolio read covers. */
  async function portfolioScope(finalized: boolean) {
    const indexed = indexedBlock(),
      finalizedBlock = Math.min(indexed, await finalityBlock());
    return { finalizedBlock, through: finalized ? finalizedBlock : indexed };
  }
  /** Newest-first page of replayed items strictly before the "block:logIndex" cursor. */
  function replayPage<T extends { blockNumber: number; logIndex: number }>(
    items: readonly T[],
    cursor: [number, number],
    limit: number,
    finalizedBlock: number,
  ) {
    const [cursorBlock, cursorLog] = cursor,
      page: Array<T & { finality: "finalized" | "included" }> = [];
    for (let index = items.length - 1; index >= 0 && page.length < limit; index--) {
      const item = items[index];
      if (item.blockNumber > cursorBlock || (item.blockNumber === cursorBlock && item.logIndex >= cursorLog))
        continue;
      page.push({ ...item, finality: item.blockNumber <= finalizedBlock ? "finalized" : "included" });
    }
    const last = page.at(-1);
    return {
      items: page,
      nextCursor: page.length === limit && last ? `${last.blockNumber}:${last.logIndex}` : null,
    };
  }

  app.get("/v1/portfolio/:address", async (request, reply) => {
    await sync();
    const params = parse(accountParams, request.params, reply),
      query = params && parse(finalityQuery, request.query, reply);
    if (!params || !query) return;
    const scope = await portfolioScope(query.finalized),
      replay = portfolio(params.address, scope.through, query.finalized),
      totals = replay.totals,
      netPnl = totals.realizedPnl - totals.fees + totals.funding - totals.liquidationPenalties,
      netDeposits = totals.deposits - totals.withdrawals + totals.transfers,
      stored = db
        .prepare(
          `SELECT collateral FROM ${query.finalized ? "finalized_accounts" : "accounts"} WHERE account=?`,
        )
        .get(params.address) as { collateral: string } | undefined;

    return {
      account: params.address,
      finality: query.finalized ? "finalized" : "included",
      indexedBlock: scope.through,
      finalizedBlock: scope.finalizedBlock,
      realizedPnl: totals.realizedPnl.toString(),
      fees: totals.fees.toString(),
      funding: totals.funding.toString(),
      liquidationPenalties: totals.liquidationPenalties.toString(),
      deficitCovered: totals.deficitCovered.toString(),
      netPnl: netPnl.toString(),
      deposits: totals.deposits.toString(),
      withdrawals: totals.withdrawals.toString(),
      marginTransfers: totals.transfers.toString(),
      netDeposits: netDeposits.toString(),
      collateral: (netDeposits + netPnl + totals.deficitCovered).toString(),
      indexedCollateral: stored?.collateral ?? null,
      volume: totals.volume.toString(),
      tradeCount: totals.tradeCount,
      fundingCount: replay.funding.length,
      positions: Object.fromEntries(
        Object.entries(replay.positions).map(([market, position]) => [
          market,
          { size: position.size.toString(), entryPrice: position.entryPrice.toString() },
        ]),
      ),
      firstEventMs: replay.firstEventMs,
      lastEventMs: replay.lastEventMs,
      incomplete: replay.incomplete,
    };
  });
  app.get("/v1/portfolio/:address/history", async (request, reply) => {
    await sync();
    const params = parse(accountParams, request.params, reply),
      query = params && parse(portfolioHistoryQuery, request.query, reply);
    if (!params || !query) return;
    const scope = await portfolioScope(query.finalized),
      replay = portfolio(params.address, scope.through, query.finalized),
      points = bucketPoints(replay.points, query.interval);
    return {
      account: params.address,
      interval: query.interval,
      finality: query.finalized ? "finalized" : "included",
      indexedBlock: scope.through,
      truncated: points.length > query.limit,
      points: points.slice(-query.limit),
    };
  });
  app.get("/v1/portfolio/:address/trades", async (request, reply) => {
    await sync();
    const params = parse(accountParams, request.params, reply),
      query = params && parse(portfolioPageQuery, request.query, reply);
    if (!params || !query) return;
    const scope = await portfolioScope(query.finalized),
      replay = portfolio(params.address, scope.through, query.finalized),
      fills = query.market ? replay.fills.filter((fill) => fill.market === query.market) : replay.fills;
    return {
      ...replayPage(fills, query.cursor, query.limit, scope.finalizedBlock),
      realizedPnl: replay.totals.realizedPnl.toString(),
      indexedBlock: scope.through,
    };
  });
  app.get("/v1/funding/:address", async (request, reply) => {
    await sync();
    const params = parse(accountParams, request.params, reply),
      query = params && parse(portfolioPageQuery, request.query, reply);
    if (!params || !query) return;
    const scope = await portfolioScope(query.finalized),
      replay = portfolio(params.address, scope.through, query.finalized),
      items = query.market ? replay.funding.filter((item) => item.market === query.market) : replay.funding;
    return {
      ...replayPage(items, query.cursor, query.limit, scope.finalizedBlock),
      totalFunding: items.reduce((sum, item) => sum + BigInt(item.amount), 0n).toString(),
      indexedBlock: scope.through,
    };
  });
  /** Isolated account -> owner, from the margin moves that created them (the address is derived, so checkable). */
  function isolatedOwners(throughBlock: number) {
    const owners = new Map<string, string>(),
      rows = db
        .prepare("SELECT payload FROM activity WHERE kind='MarginTransferred' AND block_number<=?")
        .all(throughBlock) as Array<{ payload: string }>;
    for (const row of rows) {
      const { account, counterparty, market } = JSON.parse(row.payload) as Record<string, string>;
      if (!account || !counterparty || market === undefined) continue;
      const isolated = getAddress(account),
        owner = getAddress(counterparty);
      if (isolatedAccountAddress(owner, Number(market)) === isolated) owners.set(isolated, owner);
    }
    return owners;
  }
  /** Leaderboards are recomputed at most once per (indexed block, finality, window). */
  const leaderboardCache = new Map<string, Map<string, WindowStats & { accounts: string[] }>>();
  function traderStats(throughBlock: number, finalized: boolean, window: LeaderboardWindow) {
    const key = `${throughBlock}:${finalized}:${window}`,
      cached = leaderboardCache.get(key);
    if (cached) return cached;
    // Windows end at the newest indexed block's time, so the board only moves when the index does.
    const endMs =
        ((
          db.prepare("SELECT max(timestamp) value FROM blocks WHERE number<=?").get(throughBlock) as {
            value: number | null;
          }
        ).value ?? 0) * 1_000,
      sinceMs = window === "all" ? -Infinity : endMs - LEADERBOARD_WINDOWS[window],
      accounts = db
        .prepare("SELECT DISTINCT account FROM activity WHERE kind='TradeExecuted' AND block_number<=?")
        .all(throughBlock) as Array<{ account: string }>,
      stats = new Map<string, WindowStats>();
    for (const { account } of accounts)
      stats.set(account, windowStats(portfolio(account, throughBlock, finalized), sinceMs));
    const owners = isolatedOwners(throughBlock),
      merged = mergeByOwner(stats, (account) => owners.get(account));
    if (leaderboardCache.size >= 16) leaderboardCache.clear();
    leaderboardCache.set(key, merged);
    return merged;
  }
  app.get("/v1/leaderboard", async (request, reply) => {
    await sync();
    const query = parse(leaderboardQuery, request.query, reply);
    if (!query) return;
    const scope = await portfolioScope(query.finalized);
    return {
      window: query.window,
      sort: query.sort,
      finality: query.finalized ? "finalized" : "included",
      indexedBlock: scope.through,
      traders: rankTraders(
        traderStats(scope.through, query.finalized, query.window),
        query.sort,
        query.limit,
      ),
    };
  });
  /** Weekly points of an owner and its isolated accounts. */
  function pointsOf(owner: string, throughBlock: number, finalized: boolean, owners: Map<string, string>) {
    const accounts = [
      owner,
      ...[...owners].filter(([, value]) => value === owner).map(([isolated]) => isolated),
    ];
    return {
      accounts,
      ...weeklyPoints(accounts.map((account) => portfolio(account, throughBlock, finalized))),
    };
  }
  const refereesOf = (referrer: string) =>
    (
      db
        .prepare("SELECT account FROM referrals WHERE referrer=? ORDER BY created_ms,account")
        .all(referrer) as Array<{
        account: string;
      }>
    ).map((row) => row.account);
  app.get("/v1/points/:address", async (request, reply) => {
    await sync();
    const params = parse(accountParams, request.params, reply),
      query = params && parse(finalityQuery, request.query, reply);
    if (!params || !query) return;
    const scope = await portfolioScope(query.finalized),
      owners = isolatedOwners(scope.through),
      own = pointsOf(params.address, scope.through, query.finalized, owners),
      referees = refereesOf(params.address),
      bonus = referralBonus(
        referees.map((referee) => BigInt(pointsOf(referee, scope.through, query.finalized, owners).total)),
      );
    return {
      account: params.address,
      finality: query.finalized ? "finalized" : "included",
      indexedBlock: scope.through,
      ...own,
      referees: referees.length,
      referralPoints: bonus.toString(),
      totalWithReferrals: (BigInt(own.total) + bonus).toString(),
    };
  });
  let chainId: Promise<bigint> | undefined;
  app.post("/v1/referrals", async (request, reply) => {
    const body = parse(referralBody, request.body, reply);
    if (!body) return;
    const termsError = referralTermsError(body, Math.floor(Date.now() / 1_000));
    if (termsError) return reply.code(400).send({ error: termsError });
    chainId ??= provider.getNetwork().then((network) => network.chainId);
    let digest: string;
    try {
      digest = referralDigest(await chainId, getAddress(options.clearingAddress), body);
    } catch {
      chainId = undefined;
      return reply.code(503).send({ error: "chain unavailable" });
    }
    // An isolated account has no key, so only an EOA or an ERC-1271 wallet can bind a referrer.
    if (!(await validOwnerSignature(body.account, digest, body.signature, readProvider)))
      return reply.code(401).send({ error: "invalid referral signature" });
    const inserted = db
      .prepare(
        "INSERT INTO referrals(account,referrer,issued_at,signature,created_ms) VALUES(?,?,?,?,?) ON CONFLICT(account) DO NOTHING",
      )
      .run(body.account, body.referrer, body.issuedAt, body.signature, Date.now());
    if (!inserted.changes) {
      const existing = db.prepare("SELECT referrer FROM referrals WHERE account=?").get(body.account) as {
        referrer: string;
      };
      // Re-submitting the same referral is idempotent; a different referrer is refused.
      if (existing.referrer !== body.referrer) return reply.code(409).send({ error: "referrer already set" });
    }
    return { account: body.account, referrer: body.referrer };
  });
  app.get("/v1/referrals/:address", async (request, reply) => {
    const params = parse(accountParams, request.params, reply);
    if (!params) return;
    const row = db.prepare("SELECT referrer FROM referrals WHERE account=?").get(params.address) as
        { referrer: string } | undefined,
      referees = refereesOf(params.address);
    return { account: params.address, referrer: row?.referrer ?? null, referees };
  });
  // Reads contract state directly, so it does not wait on a log sync: a slow sync must not starve the
  // hedger's once-a-second exposure check.
  app.get("/v1/exposure", async (request, reply) => {
    const query = parse(finalityQuery, request.query, reply);
    if (!query) return;
    const head = await readProvider.getBlockNumber(),
      blockTag = query.finalized
        ? Math.max(options.startBlock ?? 0, head - (options.confirmations ?? 2))
        : head;
    // Every market the chain has at this block. One the registry has not loaded yet is reported as
    // `market #i`, which the hedger cannot map and so does not hedge.
    const count = Number(await readContract.marketCount({ blockTag }));
    if (count > marketRegistry.count) await marketRegistry.ensureCount(count).catch(() => {});
    const states = await Promise.all(
      Array.from({ length: count }, (_, index) => readContract.markets(index, { blockTag })),
    );
    const market = (state: { aggregateBase: bigint; lastBid: bigint; lastAsk: bigint }) => ({
      aggregateBase: state.aggregateBase.toString(),
      bid: state.lastBid.toString(),
      ask: state.lastAsk.toString(),
    });
    return {
      blockNumber: blockTag,
      markets: Object.fromEntries(states.map((state, index) => [marketLabel(index), market(state)])),
    };
  });
  app.get("/v1/risk", async (request, reply) => {
    await sync();
    const query = parse(finalityQuery, request.query, reply);
    if (!query) return;
    return query.finalized ? finalizedRisk.snapshot(finalizedCursor()) : liveRisk.snapshot(indexedBlock());
  });
  app.get("/v1/positions", async (request, reply) => {
    await sync();
    const query = parse(positionsQuery, request.query, reply);
    if (!query) return;
    const table = tables(query.finalized),
      market = query.market === undefined ? undefined : marketIndex(query.market),
      // Only open positions are stored, so an account is open when it has a position row.
      open = `EXISTS (SELECT 1 FROM ${table.positions} p WHERE p.account=a.account${market === undefined ? "" : " AND p.market=?"})`,
      openParams = market === undefined ? [] : [market],
      where = query.cursor ? `${open} AND a.account > ?` : open,
      params = query.cursor ? [...openParams, query.cursor, query.limit] : [...openParams, query.limit],
      rows = db
        .prepare(
          `SELECT a.account,a.collateral,a.indexed_block FROM ${table.accounts} a WHERE ${where} ORDER BY a.account LIMIT ?`,
        )
        .all(...params) as Array<Record<string, string | number>>,
      total = Number(
        (
          db.prepare(`SELECT count(*) value FROM ${table.accounts} a WHERE ${open}`).get(...openParams) as {
            value: number;
          }
        ).value,
      ),
      positions = storedPositions(
        query.finalized,
        rows.map((row) => String(row.account)),
      ),
      items = rows.map((row) => ({
        account: String(row.account),
        collateral: String(row.collateral),
        positions: positionView(positions.get(String(row.account))),
      }));
    return {
      items,
      total,
      nextCursor: items.length === query.limit ? items[items.length - 1].account : null,
      indexedBlock: query.finalized ? finalizedCursor() : indexedBlock(),
      finality: query.finalized ? "finalized" : "included",
    };
  });
  app.get("/v1/protocol", async () => {
    await sync();
    const blockNumber = await provider.getBlockNumber();
    const [epoch, signerSetVersion, policyVersion, paused, resolutionRequired] = await Promise.all([
      contract.leaderEpoch(),
      contract.signerSetVersion(),
      contract.policyVersion(),
      contract.paused(),
      contract.resolutionRequired(),
    ]);
    return {
      blockNumber,
      leaderEpoch: epoch.toString(),
      signerSetVersion: signerSetVersion.toString(),
      policyVersion: policyVersion.toString(),
      paused,
      resolutionRequired,
    };
  });
  app.addHook("onReady", async () => {
    // Market names for responses; the index is the stored key, so a lagging registry only delays names.
    registryWatch = await watchMarketRegistry(readContract, {
      intervalMs: options.marketRefreshMs ?? marketRefreshIntervalMs(),
      requireInitial: false,
      onChange: () => portfolioCache.clear(),
      onError: (error) => logError("indexer market registry refresh failed:", error),
    });
    await sync();
    timer = setInterval(() => void sync(), options.pollMs ?? 500);
    timer.unref();
    heartbeat = setInterval(() => updateClients.heartbeat(), 15_000);
    heartbeat.unref();
  });
  app.addHook("onClose", async () => {
    registryWatch?.stop();
    if (timer) clearInterval(timer);
    if (heartbeat) clearInterval(heartbeat);
    updateClients.close();
    await syncing;
    db.close();
  });
  return app;
}
