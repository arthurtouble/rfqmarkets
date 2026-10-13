import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { MainnetRpcProvider, isRateLimited } from "./mainnet-rpc.js";

/** A JSON-RPC server on Base's chain id that refuses the first `refusals` block-number calls the way mainnet.base.org does. */
async function rpcServer(refusals: number) {
  const calls: string[] = [];
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      const payload = JSON.parse(body) as { id: number; method: string };
      calls.push(payload.method);
      const reply =
        payload.method === "eth_chainId"
          ? { result: "0x2105" }
          : refusals-- > 0
            ? { error: { code: -32007, message: "25/second request limit reached" } }
            : { result: "0x10" };
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ jsonrpc: "2.0", id: payload.id, ...reply }));
    });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, calls, server };
}

test("retries rate-limited calls and stops checking the chain once it is known", async () => {
  const rpc = await rpcServer(2);
  const provider = new MainnetRpcProvider(rpc.url, { attempts: 4, delayMs: 1 });
  try {
    assert.equal((await provider.getNetwork()).chainId, 8453n);
    assert.equal(await provider.getBlockNumber(), 16);
    for (let i = 0; i < 5; i++) assert.equal(await provider.send("eth_blockNumber", []), "0x10");
    // The chain is read while the provider starts up, never again per call.
    assert.ok(rpc.calls.filter((method) => method === "eth_chainId").length <= 2);
    assert.equal(rpc.calls.filter((method) => method === "eth_blockNumber").length, 8);
  } finally {
    provider.destroy();
    rpc.server.close();
  }
});

test("gives up after the configured attempts", async () => {
  const rpc = await rpcServer(10);
  const provider = new MainnetRpcProvider(rpc.url, { attempts: 3, delayMs: 1 });
  try {
    await assert.rejects(provider.getBlockNumber(), (error) => isRateLimited(error));
    assert.equal(rpc.calls.filter((method) => method === "eth_blockNumber").length, 3);
  } finally {
    provider.destroy();
    rpc.server.close();
  }
});

test("does not treat other RPC errors as rate limits", () => {
  assert.equal(isRateLimited({ error: { code: -32000, message: "nonce too low" } }), false);
  assert.equal(isRateLimited({ info: { responseStatus: "429 Too Many Requests" } }), true);
});
