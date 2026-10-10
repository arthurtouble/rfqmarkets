import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { AbstractProvider, Contract, Interface, encodeBytes32String, type TransactionRequest } from "ethers";
import { clearingStateAbi } from "./abi.js";
import { readMarketsFromChain } from "./markets.js";
import { FallbackRpcProvider, MULTICALL3_ADDRESS, readViews } from "./rpc.js";

const itemAbi = [
  "function count() view returns (uint8)",
  "function item(uint256) view returns (uint256 value,bool live)",
];
const target = "0x00000000000000000000000000000000000000aa";
const multicall3 = new Interface([
  "function aggregate3((address target,bool allowFailure,bytes callData)[] calls) payable returns ((bool success,bytes returnData)[] returnData)",
]);

type Answer = (name: string, args: unknown[]) => unknown[];
const itemAnswer: Answer = (name, args) =>
  name === "count" ? [3] : [100n + BigInt(args[0] as number), Number(args[0]) % 2 === 0];

/** A chain with one contract (`abi`, answering with `answer`) and, optionally, Multicall3; counts eth_calls. */
class FakeChain extends AbstractProvider {
  calls = 0;
  private contract: Interface;
  constructor(
    private multicall: boolean,
    abi: readonly string[] = itemAbi,
    private respond: Answer = itemAnswer,
  ) {
    super(8453);
    this.contract = new Interface(abi);
  }
  private answer(data: string) {
    const parsed = this.contract.parseTransaction({ data })!;
    return this.contract.encodeFunctionResult(parsed.fragment, this.respond(parsed.name, [...parsed.args]));
  }
  override async getCode(address: string) {
    return this.multicall && address === MULTICALL3_ADDRESS ? "0x6080" : "0x";
  }
  override async call(tx: TransactionRequest) {
    this.calls++;
    const data = String(tx.data);
    if (tx.to === MULTICALL3_ADDRESS) {
      const [calls] = multicall3.decodeFunctionData("aggregate3", data);
      return multicall3.encodeFunctionResult("aggregate3", [
        calls.map((call: { callData: string }) => [true, this.answer(call.callData)]),
      ]);
    }
    return this.answer(data);
  }
}

test("readViews batches a contract's view reads into one eth_call through Multicall3", async () => {
  for (const multicall of [true, false]) {
    const chain = new FakeChain(multicall),
      contract = new Contract(target, itemAbi, chain);
    const [count, first, second] = (await readViews(contract, [["count"], ["item", 0], ["item", 1]], 7)) as [
      bigint,
      { value: bigint; live: boolean },
      { value: bigint; live: boolean },
    ];
    assert.equal(count, 3n);
    assert.deepEqual([first.value, first.live, second.value, second.live], [100n, true, 101n, false]);
    assert.equal(chain.calls, multicall ? 1 : 3, multicall ? "one aggregated call" : "one call per view");
  }
});

test("the market registry reads every market in one aggregated call", async () => {
  const symbols = ["BTC", "ETH", "SOL"],
    answer: Answer = (name, args) => {
      const index = Number(args[0]);
      if (name === "marketCount") return [symbols.length];
      if (name === "defaultSpread") return [5];
      if (name === "marketSpread") return [index === 0 ? 8 : 0];
      if (name === "marketParams") return [[encodeBytes32String(symbols[index]), 10 + index, 500, 10_000]];
      if (name === "markets") return [0, 0, 0, 0, 0, 0, index !== 2];
      throw new Error(`unexpected ${name}`);
    };
  const results = [];
  for (const multicall of [true, false]) {
    const chain = new FakeChain(multicall, clearingStateAbi, answer);
    results.push(await readMarketsFromChain(new Contract(target, clearingStateAbi, chain)));
    // marketCount, defaultSpread, then the markets: one call, or three per market.
    assert.equal(chain.calls, multicall ? 3 : 2 + 3 * symbols.length);
  }
  assert.deepEqual(results[0], results[1]);
  assert.deepEqual(
    results[0].map((market) => [market.symbol, market.impactK, market.enabled, market.baseSpreadBps]),
    [
      ["BTC", 10n, true, 8],
      ["ETH", 11n, true, 5],
      ["SOL", 12n, false, 5],
    ],
  );
});

/** A JSON-RPC server answering eth_blockNumber with `block`, or failing with `status`. */
async function rpcServer(behaviour: { block?: string; status?: number; error?: string }) {
  let requests = 0;
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      requests++;
      const { id } = JSON.parse(body);
      if (behaviour.status) return response.writeHead(behaviour.status).end("rate limited");
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify(
          behaviour.error
            ? { jsonrpc: "2.0", id, error: { code: -32005, message: behaviour.error } }
            : { jsonrpc: "2.0", id, result: behaviour.block },
        ),
      );
    });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    requests: () => requests,
    close: () => new Promise((done) => (server as Server).close(done)),
  };
}

test("FallbackRpcProvider uses its first RPC and only falls back when that fails", async () => {
  const free = await rpcServer({ block: "0x10" }),
    limited = await rpcServer({ status: 429 }),
    erroring = await rpcServer({ error: "request limit reached" }),
    metered = await rpcServer({ block: "0x20" });
  const options = { batchMaxCount: 1, staticNetwork: true } as const;
  try {
    const healthy = new FallbackRpcProvider([free.url, metered.url], 8453, options);
    assert.equal(await healthy.send("eth_blockNumber", []), "0x10");
    assert.equal(metered.requests(), 0, "the metered RPC is untouched while the first answers");
    healthy.destroy();

    for (const failing of [limited, erroring]) {
      const before = failing.requests(),
        provider = new FallbackRpcProvider([failing.url, metered.url], 8453, options);
      assert.equal(await provider.send("eth_blockNumber", []), "0x20");
      assert.equal(failing.requests() - before, 1, "no back-off retries on the first RPC");
      provider.destroy();
    }
  } finally {
    await Promise.all([free.close(), limited.close(), erroring.close(), metered.close()]);
  }
});
