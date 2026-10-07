import assert from "node:assert/strict";
import test from "node:test";
import { Wallet } from "ethers";
import { ensureOracleSigner, oracleDomainFor, publicOracleSigner } from "./oracle-identity.mjs";
import {
  oracleNodeMarketEnv,
  oracleRequestRoute,
  oracleSyncMarkets,
  oracleWorkerMarkets,
  oracleWorkerSettings,
} from "./oracle-worker-routes.mjs";

test("oracle workers price configured markets or the clearing registry", () => {
  assert.deepEqual(oracleWorkerMarkets({}), [
    { id: 0, symbol: "BTC" },
    { id: 1, symbol: "ETH" },
  ]);
  assert.deepEqual(oracleWorkerMarkets({ ORACLE_MARKETS: "0:BTC, 1:ETH, 2:SOL" }).at(-1), {
    id: 2,
    symbol: "SOL",
  });
  assert.throws(() => oracleWorkerMarkets({ ORACLE_MARKETS: "128:SOL" }), /invalid ORACLE_MARKETS/);
  const deployment = { contracts: { clearingProxy: "0x000000000000000000000000000000000000bEEF" } };
  assert.deepEqual(oracleNodeMarketEnv({}, deployment), { ORACLE_MARKETS: "0:BTC,1:ETH" });
  assert.deepEqual(oracleNodeMarketEnv({ ORACLE_RPC_URL: "https://rpc" }, deployment), {
    ORACLE_RPC_URL: "https://rpc",
    ORACLE_CLEARING_ADDRESS: deployment.contracts.clearingProxy,
  });
  assert.equal(
    oracleNodeMarketEnv({ ORACLE_RPC_URL: "https://rpc", ORACLE_MARKETS: "0:BTC" }, deployment)
      .ORACLE_MARKETS,
    "0:BTC",
    "an explicit list restricts the registry",
  );
  const fallback = oracleWorkerMarkets({});
  assert.deepEqual(oracleSyncMarkets(null, fallback), fallback);
  assert.deepEqual(
    oracleSyncMarkets({ markets: [{ market: 2, symbol: "SOL", included: true }, { market: "x" }] }, fallback),
    [{ id: 2, symbol: "SOL" }],
  );
});

const memory = () => {
  const map = new Map();
  return { get: async (key) => map.get(key), put: async (key, value) => void map.set(key, value) };
};

test("the oracle key is created once, kept, and only its address is published", async () => {
  const storage = memory(),
    first = await ensureOracleSigner(storage);
  assert.deepEqual(await ensureOracleSigner(storage), first);
  assert.equal(new Wallet(first.privateKey).address, first.address);
  assert.deepEqual(publicOracleSigner(first), { address: first.address });
  assert.notEqual((await ensureOracleSigner(memory())).address, first.address);
});

test("a node signs only for a deployed adapter whose signer set includes it", () => {
  const address = Wallet.createRandom().address,
    adapter = "0x000000000000000000000000000000000000dead";
  assert.deepEqual(oracleDomainFor(null, address), { ready: false, reason: "contracts_not_deployed" });
  assert.equal(oracleDomainFor({ contracts: {} }, address).reason, "oracle_adapter_missing");
  assert.equal(
    oracleDomainFor(
      { contracts: { oracleAdapter: adapter }, oracle: { signers: [Wallet.createRandom().address] } },
      address,
    ).reason,
    "signer_not_in_deployment",
  );
  assert.deepEqual(
    oracleDomainFor(
      { contracts: { oracleAdapter: adapter }, oracle: { signers: [address.toLowerCase()] } },
      address,
    ),
    { ready: true, verifyingContract: "0x000000000000000000000000000000000000dEaD" },
  );
});

test("oracle workers expose only read routes and need a valid node index and region", () => {
  assert.equal(oracleRequestRoute(new Request("https://o.example/health")), "node");
  assert.equal(oracleRequestRoute(new Request("https://o.example/v1/batch/stream")), "node");
  assert.equal(oracleRequestRoute(new Request("https://o.example/v1/history/batches?market=0")), "history");
  assert.equal(
    oracleRequestRoute(new Request("https://o.example/v1/batches")),
    null,
    "collector route stays private",
  );
  assert.equal(oracleRequestRoute(new Request("https://o.example/v1/candles")), null);
  assert.equal(oracleRequestRoute(new Request("https://o.example/health", { method: "POST" })), "method");
  assert.deepEqual(oracleWorkerSettings({ ORACLE_NODE_INDEX: "2", ORACLE_LOCATION_HINT: "weur" }), {
    index: 2,
    instance: "oracle-node-2",
    locationHint: "weur",
  });
  assert.throws(() => oracleWorkerSettings({ ORACLE_NODE_INDEX: "4", ORACLE_LOCATION_HINT: "weur" }));
  assert.throws(() => oracleWorkerSettings({ ORACLE_NODE_INDEX: "1", ORACLE_LOCATION_HINT: "mars" }));
});
