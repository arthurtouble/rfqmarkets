import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";

const api = process.env.RFQ_API_URL ?? "http://127.0.0.1:4100",
  count = Number(process.env.RFQ_QUOTE_LOAD_COUNT ?? 50);
assert(Number.isInteger(count) && count > 0 && count <= 500, "invalid load count");
const requests = Array.from({ length: count }, (_, index) =>
  (async () => {
    const started = performance.now(),
      response = await fetch(`${api}/v1/quote`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          market: index % 2 ? "ETH" : "BTC",
          side: index % 4 < 2 ? "buy" : "sell",
          amount: "100",
        }),
      });
    const body = await response.text();
    return { status: response.status, latencyMs: performance.now() - started, body };
  })(),
);
const results = await Promise.all(requests),
  failures = results.filter((result) => result.status !== 200),
  latencies = results.map((result) => result.latencyMs).sort((a, b) => a - b),
  percentile = (value: number) =>
    latencies[Math.min(latencies.length - 1, Math.ceil(value * latencies.length) - 1)];
assert.equal(failures.length, 0, failures[0]?.body);
assert(
  percentile(0.95) < 2_000,
  `p95 quote latency ${percentile(0.95).toFixed(1)}ms exceeded local 2000ms gate`,
);
console.log(
  `Quote load smoke passed: ${count} concurrent, p50=${percentile(0.5).toFixed(1)}ms p95=${percentile(0.95).toFixed(1)}ms p99=${percentile(0.99).toFixed(1)}ms, 0 failures`,
);
