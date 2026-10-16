import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HyperliquidVenue } from "./hyperliquid.js";

test("Hyperliquid venue speaks the private bridge protocol without exposing the signer in requests", async () => {
  const directory = mkdtempSync(join(tmpdir(), "rfq-hyperliquid-")),
    bridge = join(directory, "bridge.py");
  writeFileSync(
    bridge,
    `import json, os, sys
for line in sys.stdin:
 r=json.loads(line); m=r["method"]; p=r.get("params",{})
 if m=="verify": out={"accountAddress":os.environ["RFQ_HYPERLIQUID_ACCOUNT_ADDRESS"],"agentAddress":"0x"+"22"*20,"agentName":os.environ["RFQ_HYPERLIQUID_AGENT_NAME"],"validUntil":999,"perpAccountValue":"1000","usablePerpUsdc":"1000","spotUsdc":"0"}
 elif m=="position": out={"base":"1250000000000000000" if p["market"]=="BTC" else "0"}
 elif m=="execution": out={"estimatedCostBps":3.5,"latencyMs":24,"basisBps":-1.25,"depthUsdc":"50000000000","observedAtMs":1234}
 elif m=="find": out=None
 elif m=="submit": out={"venueOrderId":"42","status":"filled","filledBase":p["baseDelta"]}
 elif m=="close": out={"closed":True}
 else: raise Exception("bad method")
 print(json.dumps({"id":r["id"],"ok":True,"result":out}),flush=True)
 if m=="close": break
`,
  );
  const venue = new HyperliquidVenue({
    accountAddress: `0x${"11".repeat(20)}`,
    agentPrivateKey: `0x${"33".repeat(32)}`,
    agentName: "test-agent",
    pythonPath: "python3",
    bridgePath: bridge,
    requestTimeoutMs: 2_000,
  });
  try {
    assert.equal((await venue.verify()).agentName, "test-agent");
    assert.equal(await venue.position("BTC"), 1_250_000_000_000_000_000n);
    assert.equal((await venue.execution("BTC", 100_000_000_000n, 50_000_000_000n)).estimatedCostBps, 3.5);
    assert.equal(await venue.find(`0x${"44".repeat(32)}`), null);
    assert.deepEqual(
      await venue.submit({
        clientId: `0x${"55".repeat(32)}`,
        market: "ETH",
        baseDelta: -2_000_000_000_000_000_000n,
        limitPrice: 3_000_000_000n,
      }),
      { venueOrderId: "42", status: "filled", filledBase: -2_000_000_000_000_000_000n },
    );
  } finally {
    await venue.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Hyperliquid venue rejects malformed credentials before starting a child", () => {
  assert.throws(
    () => new HyperliquidVenue({ accountAddress: "bad", agentPrivateKey: `0x${"33".repeat(32)}` }),
    /account/,
  );
  assert.throws(
    () => new HyperliquidVenue({ accountAddress: `0x${"11".repeat(20)}`, agentPrivateKey: "bad" }),
    /private key/,
  );
  assert.throws(
    () =>
      new HyperliquidVenue({
        accountAddress: `0x${"11".repeat(20)}`,
        agentPrivateKey: `0x${"33".repeat(32)}`,
        minimumPerpUsdc: "-1",
      }),
    /minimum/,
  );
});

test("a bridge that stops reading or floods its output fails requests instead of the process", async () => {
  const directory = mkdtempSync(join(tmpdir(), "rfq-hyperliquid-")),
    closed = join(directory, "closed.py"),
    flood = join(directory, "flood.py");
  // Answers the first request, then closes its input: the next request's write hits a closed pipe (EPIPE).
  writeFileSync(
    closed,
    'import json, os, sys, time\nsys.stdin.readline()\nos.close(0)\nprint(json.dumps({"id":1,"ok":True,"result":{"base":"0"}}), flush=True)\ntime.sleep(5)\n',
  );
  // Streams an unterminated reply larger than the buffer limit.
  writeFileSync(
    flood,
    "import sys\nsys.stdin.readline()\nwhile True:\n sys.stdout.write('x' * 65536)\n sys.stdout.flush()\n",
  );
  const venue = (bridgePath: string) =>
    new HyperliquidVenue({
      accountAddress: `0x${"11".repeat(20)}`,
      agentPrivateKey: `0x${"33".repeat(32)}`,
      pythonPath: "python3",
      bridgePath,
      requestTimeoutMs: 10_000,
    });
  const deaf = venue(closed),
    noisy = venue(flood);
  try {
    assert.equal(await deaf.position("BTC"), 0n);
    await new Promise((resolve) => setTimeout(resolve, 200));
    await assert.rejects(deaf.position("BTC"), /EPIPE|input closed/);
    await assert.rejects(noisy.position("BTC"), /size limit/);
  } finally {
    await Promise.all([deaf.close(), noisy.close()]);
    rmSync(directory, { recursive: true, force: true });
  }
});
