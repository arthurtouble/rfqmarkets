import assert from "node:assert/strict";
import test from "node:test";
import { hedgeVenueApiUrl, persistentConfigSchema, rpcEndpointsMatch } from "./persistent-config.js";

const address = (digit: string) => `0x${digit.repeat(40)}`;
const base = {
  environment: "base-mainnet",
  chainId: "8453",
  rpcUrl: "https://primary.example",
  secondaryRpcUrl: "https://secondary.example",
  clearingAddress: address("1"),
  tokenAddress: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  stateDirectory: "/var/lib/rfq/api",
  sponsorAddress: address("2"),
  port: 3000,
  startBlock: 1,
  publicRpcUrl: "https://public.example",
  corsOrigin: "https://app.example",
  hedgeRiskUrl: "https://hedge.example",
  indexerUrl: "https://indexer.example",
  apiUrl: "https://api.example",
  feedIds: [`0x${"1".repeat(64)}`, `0x${"2".repeat(64)}`],
  hedgeBandUsdc: "5000000000",
  hedgeMaxOrderUsdc: "1000000000",
  hedgeMinOrderUsdc: "1000000",
  runtimeIdentity: {
    oracleAddress: address("3"),
    oracleSigners: [address("d"), address("e"), address("f")],
    oracleThreshold: 2,
    governance: address("5"),
    emergencyCouncil: address("6"),
    implementationAddress: address("7"),
    riskMathAddress: address("8"),
    signatureVerifierAddress: address("9"),
    approvers: [address("a"), address("b"), address("c")],
    code: Array.from({ length: 7 }, (_, index) => ({
      address: address(String(index + 1)),
      hash: `0x${String(index + 1).repeat(64)}`,
    })),
  },
};

test("production host config binds mainnet chain, official USDC and venue", () => {
  assert.equal(persistentConfigSchema.parse(base).chainId, "8453");
  assert.equal(hedgeVenueApiUrl("base-mainnet"), "https://api.hyperliquid.xyz");
  assert.throws(
    () => persistentConfigSchema.parse({ ...base, chainId: "84532" }),
    /chain does not match environment/,
  );
  assert.throws(() => persistentConfigSchema.parse({ ...base, tokenAddress: address("d") }), /official USDC/);
});

test("test profile cannot select production venue", () => {
  const parsed = persistentConfigSchema.parse({
    ...base,
    environment: "base-sepolia",
    chainId: "84532",
    tokenAddress: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  });
  assert.equal(hedgeVenueApiUrl(parsed.environment), "https://api.hyperliquid-testnet.xyz");
});

test("mainnet requires an independent secondary RPC", () => {
  assert.throws(
    () => persistentConfigSchema.parse({ ...base, secondaryRpcUrl: "https://PRIMARY.example/" }),
    /secondary RPC must differ from the primary RPC on base-mainnet/,
  );
  assert.equal(rpcEndpointsMatch("https://a.example/v1/key", "https://a.example/v1/key/"), true);
  assert.equal(rpcEndpointsMatch("https://a.example/v1/key", "https://a.example/v1/other"), false);
  // The test profile accepts a shared RPC (persistent-service warns).
  assert.equal(
    persistentConfigSchema.parse({
      ...base,
      environment: "base-sepolia",
      chainId: "84532",
      tokenAddress: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
      secondaryRpcUrl: base.rpcUrl,
    }).secondaryRpcUrl,
    base.rpcUrl,
  );
});

test("hedger and approver upstreams must be https unless loopback", () => {
  for (const field of ["indexerUrl", "hedgeRiskUrl"]) {
    assert.throws(
      () => persistentConfigSchema.parse({ ...base, [field]: "http://indexer.example" }),
      /must use HTTPS unless it is loopback/,
      field,
    );
    assert.equal(
      persistentConfigSchema.parse({ ...base, [field]: "http://127.0.0.1:4100" })[field as "indexerUrl"],
      "http://127.0.0.1:4100",
    );
  }
});
