import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { FallbackRpcProvider } from "../../../packages/shared/src/rpc.js";
import { rpcProvider } from "./rpc.js";

test("service RPC providers give up on a hung RPC instead of waiting ethers' five minutes", async () => {
  const hung = createServer(() => {});
  await new Promise<void>((resolve) => hung.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(hung.address() as AddressInfo).port}`;
  const provider = rpcProvider(url, 31_337, { staticNetwork: true, timeoutMs: 200 }),
    fallback = new FallbackRpcProvider([url, url], 31_337, {
      staticNetwork: true,
      timeoutMs: 100,
      lastTimeoutMs: 200,
    });
  try {
    for (const target of [provider, fallback]) {
      const started = Date.now();
      await assert.rejects(target.getBlockNumber(), /timeout/i);
      assert(Date.now() - started < 5_000);
    }
  } finally {
    provider.destroy();
    fallback.destroy();
    hung.closeAllConnections();
    hung.close();
  }
});
