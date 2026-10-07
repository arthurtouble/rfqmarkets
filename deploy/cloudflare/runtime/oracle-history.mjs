// Price history kept by each oracle node's Durable Object in its SQLite storage (ctx.storage.sql).
// Every signed batch is kept for 30 days, so anyone can check a trade's execution price against a
// batch this node signed for the adapter's EIP-712 domain; one-minute candles are kept permanently
// for charts. Reads come only from SQLite, so history stays available while the container restarts.
// `sql` is anything with `exec(query, ...bindings)` returning `{ toArray() }`: the Durable Object
// SqlStorage, or node:sqlite in tests.

export const BATCH_RETENTION_SECONDS = 30 * 86_400;
export const MAX_BATCH_PAGE = 1_000;
export const DEFAULT_BATCH_PAGE = 300;
export const MAX_CANDLES = 1_500;
export const CANDLE_INTERVALS = {
  "1m": 60,
  "5m": 300,
  "15m": 900,
  "1h": 3_600,
  "4h": 14_400,
  "1d": 86_400,
};
const DIGITS = /^\d{1,78}$/,
  SIGNATURE = /^0x[0-9a-fA-F]{130}$/,
  ADDRESS = /^0x[0-9a-fA-F]{40}$/;

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS oracle_batches (
    observed_at INTEGER PRIMARY KEY,
    signer TEXT NOT NULL,
    chain_id TEXT NOT NULL,
    verifying_contract TEXT NOT NULL,
    signature TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS oracle_batch_prices (
    observed_at INTEGER NOT NULL,
    market INTEGER NOT NULL,
    bid TEXT NOT NULL,
    ask TEXT NOT NULL,
    PRIMARY KEY (observed_at, market)
  ) WITHOUT ROWID`,
  `CREATE INDEX IF NOT EXISTS oracle_batch_prices_market ON oracle_batch_prices (market, observed_at)`,
  `CREATE TABLE IF NOT EXISTS oracle_candles (
    market INTEGER NOT NULL,
    start INTEGER NOT NULL,
    open INTEGER NOT NULL,
    high INTEGER NOT NULL,
    low INTEGER NOT NULL,
    close INTEGER NOT NULL,
    samples INTEGER NOT NULL,
    PRIMARY KEY (market, start)
  ) WITHOUT ROWID`,
  `CREATE TABLE IF NOT EXISTS oracle_markets (id INTEGER PRIMARY KEY, symbol TEXT NOT NULL)`,
];

const rows = (sql, query, ...bindings) => sql.exec(query, ...bindings).toArray();
const integer = (value, min = 0, max = Number.MAX_SAFE_INTEGER) =>
  Number.isSafeInteger(value) && value >= min && value <= max;
/** Candle prices are stored as SQLite integers; refuse anything a JS number cannot hold exactly. */
const safePrice = (text) =>
  typeof text === "string" && DIGITS.test(text) && BigInt(text) <= BigInt(Number.MAX_SAFE_INTEGER);

/** A batch as the node serves it; throws on anything that could not be verified later. */
function validBatch(wire) {
  if (!wire || typeof wire !== "object") throw new Error("malformed batch");
  if (!integer(wire.observedAt, 1)) throw new Error("malformed batch observedAt");
  if (typeof wire.signature !== "string" || !SIGNATURE.test(wire.signature))
    throw new Error("malformed batch signature");
  if (typeof wire.signer !== "string" || !ADDRESS.test(wire.signer))
    throw new Error("malformed batch signer");
  if (typeof wire.chainId !== "string" || !/^\d{1,78}$/.test(wire.chainId))
    throw new Error("batch has no chainId");
  if (typeof wire.verifyingContract !== "string" || !ADDRESS.test(wire.verifyingContract))
    throw new Error("batch has no verifyingContract");
  if (!Array.isArray(wire.prices) || !wire.prices.length) throw new Error("batch has no prices");
  let previous = -1;
  for (const price of wire.prices) {
    if (!integer(price?.market, 0, 255) || price.market <= previous)
      throw new Error("malformed batch market");
    if (!DIGITS.test(String(price.bid)) || !DIGITS.test(String(price.ask)))
      throw new Error("malformed batch price");
    previous = price.market;
  }
  return wire;
}

export class OracleHistory {
  constructor(sql, options = {}) {
    this.sql = sql;
    this.now = options.now ?? (() => Date.now());
    /** Only batches from this signer are stored, when set. */
    this.signer = options.signer?.toLowerCase();
    for (const statement of SCHEMA) sql.exec(statement);
  }

  nowSeconds() {
    return Math.floor(this.now() / 1_000);
  }

  /** observedAt of the newest stored batch, or 0. */
  highWater() {
    return rows(this.sql, "SELECT MAX(observed_at) AS high FROM oracle_batches")[0]?.high ?? 0;
  }

  /** Start (unix seconds) of the newest stored one-minute candle of `market`, or null. */
  lastCandle(market) {
    return (
      rows(this.sql, "SELECT MAX(start) AS start FROM oracle_candles WHERE market = ?", market)[0]?.start ??
      null
    );
  }

  rememberSymbol(market, symbol) {
    if (typeof symbol === "string" && /^[A-Za-z0-9._-]{1,32}$/.test(symbol))
      this.sql.exec(
        "INSERT INTO oracle_markets (id, symbol) VALUES (?, ?) ON CONFLICT (id) DO UPDATE SET symbol = excluded.symbol WHERE symbol <> excluded.symbol",
        market,
        symbol,
      );
  }

  symbolOf(market) {
    return rows(this.sql, "SELECT symbol FROM oracle_markets WHERE id = ?", market)[0]?.symbol ?? null;
  }

  /** Stores wire batches (idempotent). Returns how many were new. */
  storeBatches(batches) {
    let stored = 0;
    for (const wire of batches) {
      const batch = validBatch(wire);
      if (this.signer && batch.signer.toLowerCase() !== this.signer)
        throw new Error("batch is not signed by this node");
      const exists = rows(
        this.sql,
        "SELECT 1 AS found FROM oracle_batches WHERE observed_at = ?",
        batch.observedAt,
      );
      if (exists.length) continue;
      this.sql.exec(
        "INSERT INTO oracle_batches (observed_at, signer, chain_id, verifying_contract, signature) VALUES (?, ?, ?, ?, ?)",
        batch.observedAt,
        batch.signer,
        batch.chainId,
        batch.verifyingContract,
        batch.signature,
      );
      for (const price of batch.prices) {
        this.sql.exec(
          "INSERT INTO oracle_batch_prices (observed_at, market, bid, ask) VALUES (?, ?, ?, ?)",
          batch.observedAt,
          price.market,
          String(price.bid),
          String(price.ask),
        );
        this.rememberSymbol(price.market, price.symbol);
      }
      stored++;
    }
    return stored;
  }

  /**
   * Upserts one-minute candles (node /v1/candles wire shape). A minute already stored is replaced only
   * by a version with at least as many samples, so a restarted node cannot shrink a finished minute.
   */
  upsertCandles(market, candles, symbol) {
    if (!integer(market, 0, 255)) throw new Error("invalid market");
    if (symbol) this.rememberSymbol(market, symbol);
    let written = 0;
    for (const candle of candles) {
      if (!integer(candle?.time, 0) || candle.time % 60 !== 0 || !integer(candle.samples, 1)) continue;
      if (![candle.open, candle.high, candle.low, candle.close].every(safePrice)) continue;
      this.sql.exec(
        `INSERT INTO oracle_candles (market, start, open, high, low, close, samples) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (market, start) DO UPDATE SET open = excluded.open, high = excluded.high, low = excluded.low,
           close = excluded.close, samples = excluded.samples WHERE excluded.samples >= oracle_candles.samples`,
        market,
        candle.time,
        Number(candle.open),
        Number(candle.high),
        Number(candle.low),
        Number(candle.close),
        candle.samples,
      );
      written++;
    }
    return written;
  }

  /** Drops signed batches older than the retention window. Candles are kept. */
  prune(nowSeconds = this.nowSeconds()) {
    const cutoff = nowSeconds - BATCH_RETENTION_SECONDS;
    this.sql.exec("DELETE FROM oracle_batch_prices WHERE observed_at < ?", cutoff);
    this.sql.exec("DELETE FROM oracle_batches WHERE observed_at < ?", cutoff);
  }

  /** Same shape as the node's /v1/candles, resampled from stored one-minute candles. */
  candles({ market, interval = "1m", from, to }) {
    const step = CANDLE_INTERVALS[interval],
      end = to ?? this.nowSeconds(),
      start = Math.max(from ?? 0, end - step * (MAX_CANDLES - 1));
    const bucketStart = Math.floor(start / step) * step;
    const candles = rows(
      this.sql,
      `WITH buckets AS (
         SELECT (start / CAST(? AS INTEGER)) * CAST(? AS INTEGER) AS bucket, MIN(start) AS first, MAX(start) AS last,
                MAX(high) AS high, MIN(low) AS low, SUM(samples) AS samples
         FROM oracle_candles WHERE market = ? AND start >= ? AND start <= ?
         GROUP BY bucket)
       SELECT b.bucket AS time, o.open AS open, b.high AS high, b.low AS low, c.close AS close, b.samples AS samples
       FROM buckets b
       JOIN oracle_candles o ON o.market = ? AND o.start = b.first
       JOIN oracle_candles c ON c.market = ? AND c.start = b.last
       ORDER BY b.bucket`,
      step,
      step,
      market,
      bucketStart,
      end,
      market,
      market,
    );
    return {
      market,
      symbol: this.symbolOf(market),
      interval,
      unit: "usdc-micro",
      candles: candles
        .filter((candle) => candle.time >= start - step + 1)
        .map((candle) => ({
          time: candle.time,
          open: String(candle.open),
          high: String(candle.high),
          low: String(candle.low),
          close: String(candle.close),
          samples: candle.samples,
        })),
    };
  }

  /**
   * Signed batches in [from, to], ascending, at most `limit`, each exactly as signed (every market of
   * the batch, so the signature can be checked). With `market`, only batches that priced it.
   * `next` is the `from` of the following page, or null.
   */
  batches({ market, from, to, limit = DEFAULT_BATCH_PAGE }) {
    const end = to ?? this.nowSeconds(),
      start = from ?? Math.max(0, end - 3_600),
      size = Math.min(Math.max(1, limit), MAX_BATCH_PAGE);
    const headers =
      market === undefined
        ? rows(
            this.sql,
            "SELECT observed_at, signer, chain_id, verifying_contract, signature FROM oracle_batches WHERE observed_at >= ? AND observed_at <= ? ORDER BY observed_at LIMIT ?",
            start,
            end,
            size + 1,
          )
        : rows(
            this.sql,
            `SELECT b.observed_at, b.signer, b.chain_id, b.verifying_contract, b.signature
             FROM oracle_batch_prices p JOIN oracle_batches b ON b.observed_at = p.observed_at
             WHERE p.market = ? AND p.observed_at >= ? AND p.observed_at <= ? ORDER BY p.observed_at LIMIT ?`,
            market,
            start,
            end,
            size + 1,
          );
    const more = headers.length > size,
      page = headers.slice(0, size);
    const prices = new Map(page.map((header) => [header.observed_at, []]));
    if (page.length) {
      const symbols = new Map(
        rows(this.sql, "SELECT id, symbol FROM oracle_markets").map((row) => [row.id, row.symbol]),
      );
      for (const price of rows(
        this.sql,
        "SELECT observed_at, market, bid, ask FROM oracle_batch_prices WHERE observed_at >= ? AND observed_at <= ? ORDER BY observed_at, market",
        page[0].observed_at,
        page.at(-1).observed_at,
      ))
        prices.get(price.observed_at)?.push({
          market: price.market,
          ...(symbols.has(price.market) ? { symbol: symbols.get(price.market) } : {}),
          bid: price.bid,
          ask: price.ask,
        });
    }
    return {
      ...(market === undefined ? {} : { market }),
      from: start,
      to: end,
      batches: page.map((header) => ({
        observedAt: header.observed_at,
        prices: prices.get(header.observed_at),
        signature: header.signature,
        signer: header.signer,
        chainId: header.chain_id,
        verifyingContract: header.verifying_contract,
      })),
      next: more ? headers[size].observed_at : null,
    };
  }
}

/**
 * Pulls what the node signed since the last sync, plus recent one-minute candles, into `history`.
 * `fetchJson(path)` reads the node (the container). Each step is bounded; a failure in one market's
 * candles does not stop the others.
 */
export async function syncHistory(history, fetchJson, { markets, maxPages = 10 } = {}) {
  const result = { batches: 0, candles: 0, errors: [] };
  try {
    let after = history.highWater();
    for (let page = 0; page < maxPages; page++) {
      const body = await fetchJson(`/v1/batches?after=${after}&limit=${MAX_BATCH_PAGE}`);
      const batches = Array.isArray(body?.batches) ? body.batches : [];
      result.batches += history.storeBatches(batches);
      if (!body?.more || !batches.length) break;
      after = batches.at(-1).observedAt;
    }
  } catch (error) {
    result.errors.push(`batches: ${error.message}`);
  }
  const now = history.nowSeconds();
  for (const market of markets ?? []) {
    try {
      // Re-read the newest stored minute: it may have been partial at the last sync.
      const last = history.lastCandle(market.id),
        from = last === null ? now - 86_400 : Math.max(last, now - 86_400);
      const body = await fetchJson(`/v1/candles?market=${market.id}&interval=1m&from=${from}&to=${now}`);
      result.candles += history.upsertCandles(market.id, body?.candles ?? [], body?.symbol ?? market.symbol);
    } catch (error) {
      result.errors.push(`candles ${market.id}: ${error.message}`);
    }
  }
  history.prune(now);
  return result;
}

const historyJson = (value, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });

const parseInteger = (value, min, max) => {
  if (value === null) return undefined;
  if (!/^\d{1,16}$/.test(value)) return null;
  const number = Number(value);
  return number >= min && number <= max ? number : null;
};

/** GET /v1/history/candles and /v1/history/batches; returns null for any other path. */
export function handleHistoryRequest(history, url) {
  const query = url.searchParams,
    market = parseInteger(query.get("market"), 0, 255),
    from = parseInteger(query.get("from"), 0, Number.MAX_SAFE_INTEGER),
    to = parseInteger(query.get("to"), 0, Number.MAX_SAFE_INTEGER);
  if (market === null || from === null || to === null)
    return historyJson({ error: "invalid history query" }, 400);
  if (from !== undefined && to !== undefined && from > to)
    return historyJson({ error: "from must not be after to" }, 400);
  if (url.pathname === "/v1/history/candles") {
    const interval = query.get("interval") ?? "1m";
    if (market === undefined || !Object.hasOwn(CANDLE_INTERVALS, interval))
      return historyJson({ error: "invalid candle query" }, 400);
    return historyJson(history.candles({ market, interval, from, to }));
  }
  if (url.pathname === "/v1/history/batches") {
    const limit = parseInteger(query.get("limit"), 1, MAX_BATCH_PAGE);
    if (limit === null) return historyJson({ error: "invalid history query" }, 400);
    return historyJson(history.batches({ market, from, to, limit }));
  }
  return null;
}
