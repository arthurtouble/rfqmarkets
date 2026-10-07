import assert from "node:assert/strict";
import test from "node:test";
import type { ChainConfig } from "../lib/types.js";
import { readPins, resolveSettlement } from "./settlement.js";

const CLEARING = "0x3333333333333333333333333333333333333333";
const TOKEN = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const ATTACKER = "0x9999999999999999999999999999999999999999";
const config = (overrides: Partial<ChainConfig> = {}): ChainConfig => ({
  chainId: "0x2105", chainName: "Base", rpcUrl: "https://evil.example/rpc", clearingAddress: CLEARING, tokenAddress: TOKEN, ...overrides,
});
const pinned = { VITE_CHAIN_ID: "8453", VITE_CLEARING_ADDRESS: CLEARING.toLowerCase(), VITE_TOKEN_ADDRESS: TOKEN };

test("an unpinned (local dev) build takes the API's config and its RPC on unknown chains", async () => {
  const local = await resolveSettlement({}, async () => config({ chainId: "0x7a69", chainName: "Local", rpcUrl: "http://127.0.0.1:8545" }));
  assert.equal(local.error, undefined);
  assert.equal(local.chain.id, 31337);
  assert.deepEqual(local.chain.rpcUrls.default.http, ["http://127.0.0.1:8545"]);
  assert.equal(local.config?.clearingAddress, CLEARING);
});

test("known chains ignore the API's RPC", async () => {
  const settlement = await resolveSettlement({}, async () => config());
  assert.equal(settlement.chain.id, 8453);
  assert.deepEqual(settlement.chain.rpcUrls.default.http, ["https://mainnet.base.org"]);
  const sepolia = await resolveSettlement({}, async () => config({ chainId: "0x14a34" }));
  assert.deepEqual(sepolia.chain.rpcUrls.default.http, ["https://sepolia.base.org"]);
});

test("a pinned build accepts a matching config", async () => {
  const settlement = await resolveSettlement(pinned, async () => config({ clearingAddress: CLEARING.toUpperCase().replace("0X", "0x") as `0x${string}` }));
  assert.equal(settlement.error, undefined);
  assert.equal(settlement.config?.clearingAddress, CLEARING);
  assert.equal(settlement.config?.tokenAddress, TOKEN);
});

test("a pinned build refuses a config naming another chain, contract or token", async () => {
  for (const [overrides, pattern] of [
    [{ chainId: "0x14a34" }, /different chain/],
    [{ clearingAddress: ATTACKER }, /different settlement contract/],
    [{ tokenAddress: ATTACKER }, /different USDC token/],
    [{ tokenAddress: undefined }, /different USDC token/],
    [{ clearingAddress: "0xnope" }, /invalid settlement contract/],
    [{ chainId: "zz" }, /invalid chain/],
  ] as const) {
    const settlement = await resolveSettlement(pinned, async () => config(overrides as Partial<ChainConfig>));
    assert.equal(settlement.config, null, String(pattern));
    assert.match(settlement.error ?? "", pattern);
    assert.equal(settlement.chain.id, 8453);
  }
});

test("an unreachable API leaves the app read-only on the pinned chain", async () => {
  const settlement = await resolveSettlement({ VITE_CHAIN_ID: "84532" }, async () => { throw new Error("offline"); });
  assert.equal(settlement.config, null);
  assert.equal(settlement.error, undefined);
  assert.equal(settlement.chain.id, 84532);
});

test("malformed pins fail closed", async () => {
  assert.throws(() => readPins({ VITE_CHAIN_ID: "base" }), /VITE_CHAIN_ID/);
  assert.throws(() => readPins({ VITE_CLEARING_ADDRESS: "0x123" }), /VITE_CLEARING_ADDRESS/);
  assert.deepEqual(readPins({ VITE_CHAIN_ID: " ", DEV: true }), {});
  const settlement = await resolveSettlement({ VITE_TOKEN_ADDRESS: "nope" }, async () => config());
  assert.equal(settlement.config, null);
  assert.match(settlement.error ?? "", /VITE_TOKEN_ADDRESS/);
});
