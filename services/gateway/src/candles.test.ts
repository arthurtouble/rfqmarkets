import assert from "node:assert/strict";
import { test } from "node:test";
import { CandleBackfill, CandleBook, parseOracleCandles, resampleCandles } from "./candles.js";
import { buildGateway } from "./server.js";

const frame = (time: number, btc: string, eth = btc) =>
  JSON.stringify({
    markets: {
      BTC: { observedAtMs: time, mid: btc, bid: btc, ask: btc },
      ETH: { observedAtMs: time, mid: eth, bid: eth, ask: eth },
    },
  });
const MIN = 60_000;

test("candle book builds one-minute OHLC of the mid and bounds retention", () => {
  const book = new CandleBook(3 * MIN);
  book.record(frame(1, "100"));
  book.record(frame(10_000, "105"));
  book.record(frame(20_000, "95"));
  book.record(frame(30_000, "101"));
  book.record(frame(MIN, "102"));
  book.record(frame(5_000, "1")); // late observation for a closed minute
  book.record("not-json");
  book.record(JSON.stringify({ markets: { BTC: { observedAtMs: 2 * MIN, mid: "-3" } } }));
  assert.deepEqual(book.range("BTC", 0, 10 * MIN), [
    { start: 0, open: 100n, high: 105n, low: 95n, close: 101n, samples: 4 },
    { start: MIN, open: 102n, high: 102n, low: 102n, close: 102n, samples: 1 },
  ]);
  book.record(frame(3 * MIN, "103"));
  book.record(frame(4 * MIN, "104"));
  assert.deepEqual(
    book.range("ETH", 0, 10 * MIN).map((candle) => candle.start),
    [3 * MIN, 4 * MIN],
  );
  assert.equal(book.earliest("BTC"), 3 * MIN);
  assert.equal(book.status().retentionMinutes, 3);
});

test("resampling merges minutes into epoch-aligned buckets", () => {
  const minutes = [0, 1, 4, 5, 9].map((minute, index) => ({
    start: minute * MIN,
    open: BigInt(100 + index),
    high: BigInt(110 + index),
    low: BigInt(90 + index),
    close: BigInt(105 + index),
    samples: 1,
  }));
  assert.deepEqual(resampleCandles(minutes, 5 * MIN), [
    { start: 0, open: 100n, high: 112n, low: 90n, close: 107n, samples: 3 },
    { start: 5 * MIN, open: 103n, high: 114n, low: 93n, close: 109n, samples: 2 },
  ]);
});

test("oracle candle responses are validated before use", () => {
  const good = { candles: [{ time: 300, open: "1", high: "3", low: "1", close: "2", samples: 4 }] };
  assert.deepEqual(parseOracleCandles(good, 5 * MIN), [
    { start: 300_000, open: 1n, high: 3n, low: 1n, close: 2n, samples: 4 },
  ]);
  assert.equal(parseOracleCandles({ candles: [{ ...good.candles[0], time: 301 }] }, 5 * MIN), null);
  assert.equal(parseOracleCandles({ candles: [{ ...good.candles[0], high: "0" }] }, 5 * MIN), null);
  assert.equal(parseOracleCandles({ candles: [{ ...good.candles[0], open: "x" }] }, 5 * MIN), null);
  assert.equal(parseOracleCandles({ error: "nope" }, 5 * MIN), null);
});

test("backfill tries each node once per ttl and caches failures", async () => {
  const calls: string[] = [];
  let now = 1_000_000_000;
  const backfill = new CandleBackfill({
    urls: ["https://a.test/v1/history/candles", "https://b.test/v1/history/candles"],
    ttlMs: 60_000,
    now: () => now,
    fetchImpl: async (url) => {
      calls.push(String(url));
      if (String(url).startsWith("https://a.test")) throw new Error("offline");
      return Response.json({ candles: [{ time: 999_960, open: "1", high: "1", low: "1", close: "1" }] });
    },
  });
  const first = await backfill.get("ETH", "1m", 999_000_000);
  assert.equal(first?.length, 1);
  assert.equal(calls.length, 2);
  assert.match(calls[1], /market=1&interval=1m&from=999000&to=1000000$/);
  await backfill.get("ETH", "1m", 999_500_000);
  assert.equal(calls.length, 2, "cached");
  now += 60_000;
  await backfill.get("ETH", "1m", 999_500_000);
  assert.equal(calls.length, 4, "refetched after ttl");
});

test("gateway serves bounded candles from the relayed stream, older buckets from the oracle backfill", async () => {
  const HOUR = 60 * MIN,
    nowMs = 10 * HOUR + 30 * MIN,
    encoder = new TextEncoder(),
    backfillCalls: string[] = [];
  let push: ((chunk: string) => void) | undefined;
  const gateway = buildGateway({
    upstreamUrl: "http://upstream",
    upstreamStallMs: 60_000,
    now: () => nowMs,
    candleBackfill: {
      urls: ["https://oracle.test/v1/history/candles"],
      fetchImpl: async (url) => {
        backfillCalls.push(String(url));
        if (!String(url).includes("interval=1h")) return Response.json({ candles: [] });
        return Response.json({
          candles: [7, 8, 9, 10].map((hour) => ({
            time: (hour * HOUR) / 1_000,
            open: "1",
            high: "9",
            low: "1",
            close: "5",
            samples: 60,
          })),
        });
      },
    },
    fetchImpl: async (_url, init) =>
      new Response(
        new ReadableStream({
          start(controller) {
            push = (chunk) => controller.enqueue(encoder.encode(chunk));
            init!.signal!.addEventListener("abort", () => controller.error(new Error("closed")), {
              once: true,
            });
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      ),
  });
  try {
    await gateway.ready();
    for (let attempt = 0; attempt < 50 && !push; attempt++) await new Promise((done) => setTimeout(done, 5));
    // The gateway started mid-hour: 10:10 and 10:20.
    push!(`event: markets\ndata: ${frame(10 * HOUR + 10 * MIN, "200", "20")}\n\n`);
    push!(`event: markets\ndata: ${frame(10 * HOUR + 20 * MIN, "210", "21")}\n\n`);
    for (let attempt = 0; attempt < 50; attempt++) {
      if ((await gateway.inject({ method: "GET", url: "/health" })).json().candles.minutes.BTC === 2) break;
      await new Promise((done) => setTimeout(done, 5));
    }
    const minutes = (
      await gateway.inject({ method: "GET", url: "/v1/candles?market=BTC&interval=1m&limit=60" })
    ).json();
    assert.equal(minutes.unit, "usdc-micro");
    assert.equal(minutes.source, "gateway", "the oracle had no minutes for this window");
    assert.deepEqual(
      minutes.candles.map((candle: { time: number; close: string }) => [candle.time, candle.close]),
      [
        [10 * HOUR + 10 * MIN, "200"],
        [10 * HOUR + 20 * MIN, "210"],
      ],
    );
    const hourly = await gateway.inject({ method: "GET", url: "/v1/candles?market=BTC&interval=1h&limit=3" });
    assert.equal(hourly.headers["cache-control"], "public, max-age=1");
    const body = hourly.json();
    assert.equal(body.source, "oracle+gateway");
    // 08:00 and 09:00 from the oracle; 10:00 too, because the local book began after 10:00.
    assert.deepEqual(
      body.candles.map((candle: { time: number; close: string }) => [candle.time, candle.close]),
      [
        [8 * HOUR, "5"],
        [9 * HOUR, "5"],
        [10 * HOUR, "5"],
      ],
    );
    assert.match(backfillCalls[1], /market=0&interval=1h&from=28800&to=37800$/);
    for (const url of [
      "/v1/candles?market=SOL",
      "/v1/candles?market=BTC&interval=2m",
      "/v1/candles?market=BTC&limit=0",
      "/v1/candles?market=BTC&limit=1001",
    ])
      assert.equal((await gateway.inject({ method: "GET", url })).statusCode, 400, url);
  } finally {
    await gateway.close();
  }
});
