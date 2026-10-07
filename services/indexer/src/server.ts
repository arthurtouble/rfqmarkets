import Fastify, { type FastifyReply } from "fastify";
import cors from "@fastify/cors";
import { DatabaseSync } from "node:sqlite";
import { Contract, Interface, JsonRpcProvider, getAddress, type Log } from "ethers";
import { z } from "zod";
import { clearingIndexerAbi } from "../../../packages/shared/src/abi.js";
import { ConnectionBudget } from "../../../packages/shared/src/connection-budget.js";
import { SseClients, openSse, sseFrame } from "../../lib/src/sse.js";
import { RiskProjection, type AccountProjection } from "./risk-projection.js";

export interface IndexerOptions {
  rpcUrl: string;
  clearingAddress: string;
  databasePath: string;
  startBlock?: number;
  confirmations?: number;
  /** Most blocks one eth_getLogs call may span; public Base RPCs cap this well below the default 10,000. */
  maxLogRange?: number;
  pollMs?: number;
  corsOrigin?: string | string[];
  provider?: JsonRpcProvider;
  /** Update-stream connection caps (global and per client IP). */
  maxStreamConnections?: number;
  maxStreamConnectionsPerClient?: number;
  /** Where sync failures are reported; defaults to stderr. Each distinct failure is logged once. */
  logError?: (message: string, error: unknown) => void;
}

const ACTIVITY_KINDS = [
  "Deposited",
  "Withdrawn",
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
const accountActivityQuery = z.object({ cursor: activityCursor, limit: pageLimit(25) });
const activityQuery = z.object({
  cursor: activityCursor,
  limit: pageLimit(25),
  kind: z.enum(ACTIVITY_KINDS, { message: "invalid activity kind" }).optional(),
  market: z.enum(["0", "1"], { message: "invalid market" }).transform(Number).optional(),
  finalized: isTrue,
});
const finalityQuery = z.object({ finalized: isTrue });
const positionsQuery = z.object({
  limit: pageLimit(50),
  // Finalized unless explicitly asked for included state.
  finalized: z
    .string()
    .optional()
    .transform((value) => value !== "false"),
  market: z.enum(["BTC", "ETH"], { message: "invalid market" }).optional(),
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
  const iface = new Interface(clearingIndexerAbi);
  const db = new DatabaseSync(options.databasePath);
  db.exec(
    "PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS blocks(number INTEGER PRIMARY KEY,hash TEXT NOT NULL,parent_hash TEXT NOT NULL,timestamp INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS activity(tx_hash TEXT NOT NULL,log_index INTEGER NOT NULL,block_number INTEGER NOT NULL,block_hash TEXT NOT NULL,timestamp INTEGER NOT NULL,kind TEXT NOT NULL,account TEXT,market INTEGER,payload TEXT NOT NULL,PRIMARY KEY(tx_hash,log_index)); CREATE INDEX IF NOT EXISTS activity_account_block ON activity(account,block_number DESC,log_index DESC); CREATE TABLE IF NOT EXISTS accounts(account TEXT PRIMARY KEY,collateral TEXT NOT NULL,btc_size TEXT NOT NULL,btc_entry TEXT NOT NULL,eth_size TEXT NOT NULL,eth_entry TEXT NOT NULL,indexed_block INTEGER NOT NULL,indexed_tx TEXT); CREATE TABLE IF NOT EXISTS finalized_accounts(account TEXT PRIMARY KEY,collateral TEXT NOT NULL,btc_size TEXT NOT NULL,btc_entry TEXT NOT NULL,eth_size TEXT NOT NULL,eth_entry TEXT NOT NULL,indexed_block INTEGER NOT NULL,indexed_tx TEXT); CREATE INDEX IF NOT EXISTS accounts_open ON accounts(account) WHERE btc_size != '0' OR eth_size != '0'; CREATE INDEX IF NOT EXISTS finalized_accounts_open ON finalized_accounts(account) WHERE btc_size != '0' OR eth_size != '0'; CREATE TABLE IF NOT EXISTS metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL)",
  );
  const liveRisk = new RiskProjection(),
    finalizedRisk = new RiskProjection();
  for (const row of db
    .prepare("SELECT account,collateral,btc_size,eth_size FROM accounts")
    .all() as AccountProjection[])
    liveRisk.update(row);
  for (const row of db
    .prepare("SELECT account,collateral,btc_size,eth_size FROM finalized_accounts")
    .all() as AccountProjection[])
    finalizedRisk.update(row);
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
        "DELETE FROM blocks; DELETE FROM activity; DELETE FROM accounts; DELETE FROM finalized_accounts; DELETE FROM metadata",
      ),
    );
    liveRisk.clear();
    finalizedRisk.clear();
  };
  async function readAccount(account: string, blockTag: number, txHash?: string) {
    const [collateral, btc, eth] = await Promise.all([
      contract.collateralOf(account, { blockTag }),
      contract.positionOf(account, 0, { blockTag }),
      contract.positionOf(account, 1, { blockTag }),
    ]);
    return {
      account,
      collateral: collateral.toString(),
      btc_size: btc.size.toString(),
      btc_entry: btc.entryPrice.toString(),
      eth_size: eth.size.toString(),
      eth_entry: eth.entryPrice.toString(),
      blockTag,
      txHash,
    };
  }
  type AccountRow = Awaited<ReturnType<typeof readAccount>>;
  function writeAccount(row: AccountRow, table: "accounts" | "finalized_accounts") {
    db.prepare(
      `INSERT INTO ${table} VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(account) DO UPDATE SET collateral=excluded.collateral,btc_size=excluded.btc_size,btc_entry=excluded.btc_entry,eth_size=excluded.eth_size,eth_entry=excluded.eth_entry,indexed_block=excluded.indexed_block,indexed_tx=excluded.indexed_tx`,
    ).run(
      row.account,
      row.collateral,
      row.btc_size,
      row.btc_entry,
      row.eth_size,
      row.eth_entry,
      row.blockTag,
      row.txHash ?? null,
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
    for (const row of stage.rows) writeAccount(row, "finalized_accounts");
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
      for (const item of finalized?.rows ?? []) finalizedRisk.update(item);
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
      for (const item of included) writeAccount(item, "accounts");
      writeFinalized(finalized);
    });
    for (const item of included) liveRisk.update(item);
    for (const item of finalized?.rows ?? []) finalizedRisk.update(item);
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
      positions: {
        BTC: { size: row.btc_size, entryPrice: row.btc_entry },
        ETH: { size: row.eth_size, entryPrice: row.eth_entry },
      },
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
    const rows = db
      .prepare(
        "SELECT * FROM activity WHERE account=? AND (block_number<? OR (block_number=? AND log_index<?)) ORDER BY block_number DESC,log_index DESC LIMIT ?",
      )
      .all(params.address, cursorBlock, cursorBlock, cursorLog, query.limit) as Array<
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
  app.get("/v1/exposure", async (request, reply) => {
    await sync();
    const query = parse(finalityQuery, request.query, reply);
    if (!query) return;
    const head = await provider.getBlockNumber(),
      blockTag = query.finalized
        ? Math.max(options.startBlock ?? 0, head - (options.confirmations ?? 2))
        : head;
    const [btc, eth] = await Promise.all([
      contract.markets(0, { blockTag }),
      contract.markets(1, { blockTag }),
    ]);
    const market = (state: { aggregateBase: bigint; lastBid: bigint; lastAsk: bigint }) => ({
      aggregateBase: state.aggregateBase.toString(),
      bid: state.lastBid.toString(),
      ask: state.lastAsk.toString(),
    });
    return { blockNumber: blockTag, markets: { BTC: market(btc), ETH: market(eth) } };
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
    const table = query.finalized ? "finalized_accounts" : "accounts",
      open =
        query.market === "BTC"
          ? "btc_size != '0'"
          : query.market === "ETH"
            ? "eth_size != '0'"
            : "(btc_size != '0' OR eth_size != '0')",
      where = query.cursor ? `${open} AND account > ?` : open,
      params = query.cursor ? [query.cursor, query.limit] : [query.limit],
      rows = db
        .prepare(
          `SELECT account,collateral,btc_size,btc_entry,eth_size,eth_entry,indexed_block FROM ${table} WHERE ${where} ORDER BY account LIMIT ?`,
        )
        .all(...params) as Array<Record<string, string | number>>,
      total = Number(
        (db.prepare(`SELECT count(*) value FROM ${table} WHERE ${open}`).get() as { value: number }).value,
      ),
      items = rows.map((row) => ({
        account: String(row.account),
        collateral: String(row.collateral),
        positions: {
          BTC: { size: String(row.btc_size), entryPrice: String(row.btc_entry) },
          ETH: { size: String(row.eth_size), entryPrice: String(row.eth_entry) },
        },
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
    await sync();
    timer = setInterval(() => void sync(), options.pollMs ?? 500);
    timer.unref();
    heartbeat = setInterval(() => updateClients.heartbeat(), 15_000);
    heartbeat.unref();
  });
  app.addHook("onClose", async () => {
    if (timer) clearInterval(timer);
    if (heartbeat) clearInterval(heartbeat);
    updateClients.close();
    await syncing;
    db.close();
  });
  return app;
}
