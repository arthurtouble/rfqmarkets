import assert from "node:assert/strict";
import { test } from "node:test";
import { getAddress, Interface, JsonRpcProvider, Wallet, type TransactionRequest } from "ethers";
import { clearingApiAbi } from "../../../packages/shared/src/abi.js";
import { buildApi } from "./server.js";

const clearing = "0x0000000000000000000000000000000000000001";
const iface = new Interface(clearingApiAbi);

/**
 * An API whose chain reports every position flat, so close quotes stop before pricing. The market
 * registry read fails, so the API keeps the launch markets (BTC, ETH).
 */
function flatChainApi() {
  const reads: string[] = [];
  class Chain extends JsonRpcProvider {
    override async send(method: string) {
      if (method === "eth_blockNumber") return "0x10";
      throw new Error(`unexpected ${method}`);
    }
    override async call(request: TransactionRequest) {
      const parsed = iface.parseTransaction({ data: String(request.data) })!;
      if (parsed.name === "positionOf") reads.push(parsed.name);
      if (parsed.name === "positionOf") return iface.encodeFunctionResult("positionOf", [0n, 0n, 0n]);
      throw new Error(`unexpected ${parsed.name}`);
    }
  }
  const provider = new Chain();
  const app = buildApi({
    provider,
    chainId: 84532n,
    verifyingContract: clearing,
    chain: {
      rpcUrl: "https://unused",
      sponsorPrivateKey: Wallet.createRandom().privateKey,
      clearingAddress: clearing,
      tokenAddress: "0x0000000000000000000000000000000000000002",
    },
  });
  return {
    app,
    reads,
    close: async () => {
      await app.close();
      provider.destroy();
    },
  };
}

const post = (app: ReturnType<typeof buildApi>, url: string, payload: unknown) =>
  app.inject({ method: "POST", url, payload: payload as object });

test("close quotes validate the account, market and fraction before reading the chain", async () => {
  const { app, reads, close } = flatChainApi();
  try {
    await app.ready();
    const account = Wallet.createRandom().address;
    for (const [url, payload] of [
      ["/v1/close/quote", { account: "0x1234", market: "BTC" }],
      ["/v1/close/quote", { account, market: "DOGE" }],
      ["/v1/close/quote", { account, market: "BTC", fraction: 0 }],
      ["/v1/close/quote", { account, market: "BTC", fraction: 10_001 }],
      ["/v1/close/quote", { account, market: "BTC", fraction: 25.5 }],
      ["/v1/close/all/quote", { account: "not an address" }],
      ["/v1/close/all/quote", { account, fraction: -1 }],
    ] as const) {
      const response = await post(app, url, payload);
      assert.equal(response.statusCode, 400, `${url} ${JSON.stringify(payload)}: ${response.body}`);
    }
    assert.deepEqual(reads, []);
  } finally {
    await close();
  }
});

test("closing a flat position is refused and close-all returns no quotes", async () => {
  const { app, reads, close } = flatChainApi();
  try {
    await app.ready();
    const account = Wallet.createRandom().address.toLowerCase();
    const single = await post(app, "/v1/close/quote", { account, market: "ETH", fraction: 5_000 });
    assert.equal(single.statusCode, 409, single.body);
    assert.equal(single.json().error, "position is already closed");

    const all = await post(app, "/v1/close/all/quote", { account });
    assert.equal(all.statusCode, 200, all.body);
    // The checksummed account comes back, with one quote per open position: none here.
    assert.equal(all.json().account, getAddress(account));
    assert.deepEqual(all.json().quotes, []);
    assert.equal(reads.length, 3, "the single close, then one read per market");
  } finally {
    await close();
  }
});

test("close quotes need a chain", async () => {
  const app = buildApi({});
  try {
    await app.ready();
    const account = Wallet.createRandom().address;
    assert.equal((await post(app, "/v1/close/quote", { account, market: "BTC" })).statusCode, 503);
    assert.equal((await post(app, "/v1/close/all/quote", { account })).statusCode, 503);
  } finally {
    await app.close();
  }
});
