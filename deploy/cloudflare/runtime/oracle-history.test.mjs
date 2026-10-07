import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { TypedDataEncoder, Wallet, verifyTypedData } from "ethers";
import {
  BATCH_RETENTION_SECONDS,
  OracleHistory,
  handleHistoryRequest,
  syncHistory,
} from "./oracle-history.mjs";

// The Durable Object's SqlStorage surface, backed by node:sqlite.
const sqlite = () => {
  const db = new DatabaseSync(":memory:");
  return {
    exec: (query, ...bindings) => {
      const rows = db.prepare(query).all(...bindings);
      return { toArray: () => rows.map((row) => ({ ...row })) };
    },
  };
};

// The adapter's EIP-712 domain and types (packages/shared/src/signed-oracle.ts).
const signer = new Wallet("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
const domain = {
  name: "RFQ Markets Oracle",
  version: "1",
  chainId: 8453n,
  verifyingContract: "0x000000000000000000000000000000000000dEaD",
};
const types = {
  PriceBatch: [
    { name: "observedAt", type: "uint64" },
    { name: "prices", type: "Price[]" },
  ],
  Price: [
    { name: "market", type: "uint8" },
    { name: "bid", type: "uint256" },
    { name: "ask", type: "uint256" },
  ],
};
const unsigned = (wire) => ({
  observedAt: BigInt(wire.observedAt),
  prices: wire.prices.map((price) => ({
    market: price.market,
    bid: BigInt(price.bid),
    ask: BigInt(price.ask),
  })),
});
async function signedBatch(observedAt, markets = [0, 1]) {
  const prices = markets.map((market) => ({
    market,
    symbol: market === 0 ? "BTC" : "ETH",
    bid: String((market === 0 ? 84_000_000_000 : 2_600_000_000) + observedAt),
    ask: String((market === 0 ? 84_001_000_000 : 2_600_100_000) + observedAt),
    sources: 5,
  }));
  const wire = {
    observedAt,
    prices,
    signer: signer.address,
    chainId: "8453",
    verifyingContract: domain.verifyingContract,
  };
  return { ...wire, signature: await signer.signTypedData(domain, types, unsigned(wire)) };
}
const candle = (time, open, high, low, close, samples = 60) => ({
  time,
  open: String(open),
  high: String(high),
  low: String(low),
  close: String(close),
  samples,
});

test("stored batches come back exactly as signed and verify against the adapter domain", async () => {
  const history = new OracleHistory(sqlite(), { signer: signer.address, now: () => 1_700_000_100_000 });
  const batches = [
    await signedBatch(1_700_000_000),
    await signedBatch(1_700_000_001, [0]),
    await signedBatch(1_700_000_002, [1]),
  ];
  assert.equal(history.storeBatches(batches), 3);
  assert.equal(history.storeBatches(batches.slice(1)), 0, "idempotent");
  assert.equal(history.highWater(), 1_700_000_002);

  const all = history.batches({ from: 1_700_000_000, to: 1_700_000_100 });
  assert.equal(all.batches.length, 3);
  assert.equal(all.next, null);
  for (const [index, batch] of all.batches.entries()) {
    assert.equal(verifyTypedData(domain, types, unsigned(batch), batch.signature), signer.address);
    assert.equal(batch.chainId, "8453");
    assert.deepEqual(
      batch.prices.map(({ market, bid, ask }) => ({ market, bid, ask })),
      batches[index].prices.map(({ market, bid, ask }) => ({ market, bid, ask })),
    );
  }
  assert.equal(all.batches[0].prices[0].symbol, "BTC");
  assert.equal(
    TypedDataEncoder.hash(domain, types, unsigned(all.batches[0])),
    TypedDataEncoder.hash(domain, types, unsigned(batches[0])),
  );

  // A market filter keeps whole batches (every price is needed to check the signature).
  const eth = history.batches({ market: 1, from: 1_700_000_000, to: 1_700_000_100 });
  assert.deepEqual(
    eth.batches.map((batch) => [batch.observedAt, batch.prices.length]),
    [
      [1_700_000_000, 2],
      [1_700_000_002, 1],
    ],
  );
  const firstPage = history.batches({ from: 1_700_000_000, to: 1_700_000_100, limit: 2 });
  assert.equal(firstPage.batches.length, 2);
  assert.equal(firstPage.next, 1_700_000_002);
  assert.equal(history.batches({ from: firstPage.next, to: 1_700_000_100, limit: 2 }).batches.length, 1);
});

test("batches from another signer or without a domain are refused", async () => {
  const history = new OracleHistory(sqlite(), { signer: Wallet.createRandom().address });
  assert.throws(() => history.storeBatches([{ observedAt: 1 }]), /malformed/);
  const batch = await signedBatch(1_700_000_000);
  assert.throws(() => history.storeBatches([batch]), /not signed by this node/);
  const open = new OracleHistory(sqlite());
  assert.throws(() => open.storeBatches([{ ...batch, verifyingContract: undefined }]), /verifyingContract/);
  assert.throws(
    () => open.storeBatches([{ ...batch, prices: [batch.prices[1], batch.prices[0]] }]),
    /market/,
  );
});

test("signed batches are pruned after 30 days; candles are kept", async () => {
  const history = new OracleHistory(sqlite());
  history.storeBatches([
    await signedBatch(1_000_000),
    await signedBatch(1_000_000 + BATCH_RETENTION_SECONDS),
  ]);
  history.upsertCandles(0, [candle(960, 1, 1, 1, 1)], "BTC");
  history.prune(1_000_001 + BATCH_RETENTION_SECONDS);
  const left = history.batches({ from: 0, to: 2 * BATCH_RETENTION_SECONDS });
  assert.deepEqual(
    left.batches.map((batch) => batch.observedAt),
    [1_000_000 + BATCH_RETENTION_SECONDS],
  );
  assert.equal(history.candles({ market: 0, from: 0, to: 2_000 }).candles.length, 1);
});

test("candles resample from one-minute rows in the node's wire shape", () => {
  const history = new OracleHistory(sqlite(), { now: () => 7_200_000 });
  history.upsertCandles(
    0,
    [
      candle(0, 100, 110, 95, 105),
      candle(60, 105, 120, 100, 101),
      candle(240, 101, 102, 90, 99),
      candle(300, 99, 130, 98, 125, 30),
    ],
    "BTC",
  );
  // A partial minute never replaces a fuller one.
  history.upsertCandles(0, [candle(300, 1, 1, 1, 1, 5)]);
  assert.deepEqual(
    history.candles({ market: 0, interval: "1m", from: 0, to: 300 }).candles.at(-1),
    candle(300, 99, 130, 98, 125, 30),
  );
  history.upsertCandles(0, [candle(300, 99, 131, 98, 126, 60)]);

  const fiveMinutes = history.candles({ market: 0, interval: "5m", from: 0, to: 600 });
  assert.equal(fiveMinutes.symbol, "BTC");
  assert.equal(fiveMinutes.unit, "usdc-micro");
  assert.deepEqual(fiveMinutes.candles, [
    candle(0, 100, 120, 90, 99, 180),
    candle(300, 99, 131, 98, 126, 60),
  ]);
  assert.deepEqual(history.candles({ market: 0, interval: "1h", from: 0, to: 3_600 }).candles, [
    candle(0, 100, 131, 90, 126, 240),
  ]);
  // The bucket holding `from` is included whole, like the node's /v1/candles.
  assert.deepEqual(
    history.candles({ market: 0, interval: "5m", from: 120, to: 600 }).candles.map((item) => item.time),
    [0, 300],
  );
  assert.deepEqual(history.candles({ market: 1, interval: "1d" }).candles, []);
  // Prices a JS number cannot hold exactly are skipped rather than rounded.
  assert.equal(history.upsertCandles(0, [candle(600, "9007199254740993", 1, 1, 1)]), 0);
});

test("sync pulls batches after the high-water mark and recent candles", async () => {
  const history = new OracleHistory(sqlite(), { signer: signer.address, now: () => 1_700_000_100_000 });
  const node = [];
  for (let second = 0; second < 5; second++) node.push(await signedBatch(1_700_000_000 + second));
  const seen = [];
  const fetchJson = async (path) => {
    seen.push(path);
    const url = new URL(path, "http://node");
    if (url.pathname === "/v1/batches") {
      const after = Number(url.searchParams.get("after")),
        page = node.filter((batch) => batch.observedAt > after).slice(0, 2);
      return { batches: page, more: node.filter((batch) => batch.observedAt > after).length > 2 };
    }
    if (url.searchParams.get("market") === "1") throw new Error("node restarting");
    return { symbol: "BTC", candles: [candle(1_699_999_980, 1, 2, 1, 2)] };
  };
  const markets = [
    { id: 0, symbol: "BTC" },
    { id: 1, symbol: "ETH" },
  ];
  const first = await syncHistory(history, fetchJson, { markets });
  assert.equal(first.batches, 5);
  assert.equal(first.candles, 1);
  assert.deepEqual(first.errors, ["candles 1: node restarting"]);
  assert.equal(history.highWater(), 1_700_000_004);
  assert.ok(seen[0].startsWith("/v1/batches?after=0&"));
  seen.length = 0;
  const second = await syncHistory(history, fetchJson, { markets: markets.slice(0, 1) });
  assert.equal(second.batches, 0);
  assert.ok(seen[0].startsWith("/v1/batches?after=1700000004&"));
  assert.equal(seen[1], "/v1/candles?market=0&interval=1m&from=1699999980&to=1700000100");
});

test("history routes validate their query and read only from storage", async () => {
  const history = new OracleHistory(sqlite(), { now: () => 1_700_000_100_000 });
  history.storeBatches([await signedBatch(1_700_000_000)]);
  history.upsertCandles(0, [candle(1_699_999_980, 1, 2, 1, 2)], "BTC");
  const get = (path) => handleHistoryRequest(history, new URL(path, "https://oracle.example"));
  const candles = get("/v1/history/candles?market=0&interval=15m");
  assert.equal(candles.status, 200);
  assert.equal((await candles.json()).candles.length, 1);
  const batches = await get("/v1/history/batches?market=0&from=1699999999&to=1700000001&limit=10").json();
  assert.equal(batches.batches[0].signer, signer.address);
  for (const bad of [
    "/v1/history/candles?interval=1m",
    "/v1/history/candles?market=0&interval=2m",
    "/v1/history/candles?market=300",
    "/v1/history/batches?from=10&to=5",
    "/v1/history/batches?limit=5000",
    "/v1/history/batches?from=-1",
  ])
    assert.equal(get(bad).status, 400, bad);
  assert.equal(get("/v1/history/other"), null);
});
