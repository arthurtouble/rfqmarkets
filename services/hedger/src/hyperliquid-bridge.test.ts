import assert from "node:assert/strict";
import { test } from "node:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { HyperliquidVenue } from "./hyperliquid.js";

// Runs the real bridge (services/hedger/hyperliquid_bridge.py) against a stand-in for Hyperliquid's
// Python SDK, so the network pin and the mainnet account fence are tested without the SDK or a venue.
const FAKE_SDK = {
  "eth_account/__init__.py": `
class _Wallet:
    address = "0x" + "22" * 20
class Account:
    @staticmethod
    def from_key(key):
        return _Wallet()
`,
  "hyperliquid/__init__.py": "",
  "hyperliquid/utils/__init__.py": "",
  "hyperliquid/utils/types.py": `
class Cloid:
    def __init__(self, raw):
        self.raw = raw
    @staticmethod
    def from_str(value):
        return Cloid(value)
    def to_raw(self):
        return self.raw
`,
  "hyperliquid/info.py": `
import json, os
STATE = os.path.join(os.path.dirname(__file__), "..", "state.json")
def _state():
    with open(STATE) as handle:
        return json.load(handle)
class Info:
    coin_to_asset = {"BTC": 0, "ETH": 1, "SOL": 2}
    asset_to_sz_decimals = {0: 5, 1: 4, 2: 2}
    def __init__(self, url):
        self.url = url
    def user_role(self, address):
        return {"role": "agent", "data": {"user": "0x" + "11" * 20}}
    def extra_agents(self, account):
        return [{"address": "0x" + "22" * 20, "name": "hedger", "validUntil": 99999999999999}]
    def open_orders(self, account):
        return _state()["openOrders"]
    def user_state(self, account):
        return {"marginSummary": {"accountValue": "1000"}, "assetPositions": [
            {"position": {"coin": coin, "szi": size}} for coin, size in _state()["positions"].items()]}
    def spot_user_state(self, account):
        return {"balances": []}
    def post(self, path, body):
        return {"availableToTrade": ["1000", "1000"]}
`,
  "hyperliquid/exchange.py": `
from hyperliquid.info import Info
class Exchange:
    def __init__(self, wallet, url, account_address=None, timeout=None):
        self.info = Info(url)
    def set_expires_after(self, value):
        pass
    def order(self, coin, is_buy, size, price, order_type, cloid=None):
        return {"status": "ok", "response": {"data": {"statuses": [{"filled": {"totalSz": str(size), "oid": 7}}]}}}
`,
};

function fakeSdk() {
  const directory = mkdtempSync(join(tmpdir(), "rfq-hyperliquid-bridge-")),
    sdk = join(directory, "sdk");
  for (const [path, source] of Object.entries(FAKE_SDK)) {
    mkdirSync(join(sdk, path, ".."), { recursive: true });
    writeFileSync(join(sdk, path), source);
  }
  // The venue passes the child a scrubbed environment, so the stand-in SDK is put on the path here.
  const python = join(directory, "python");
  writeFileSync(python, `#!/bin/sh\nPYTHONPATH='${sdk}' PYTHONDONTWRITEBYTECODE=1 exec python3 "$@"\n`);
  chmodSync(python, 0o755);
  const setState = (state: { positions: Record<string, string>; openOrders: Array<{ coin: string }> }) =>
    writeFileSync(join(sdk, "state.json"), JSON.stringify(state));
  setState({ positions: {}, openOrders: [] });
  return { directory, python, setState };
}

function venue(python: string, options: { network: "testnet" | "mainnet"; coins?: string[] }) {
  return new HyperliquidVenue({
    accountAddress: `0x${"11".repeat(20)}`,
    agentPrivateKey: `0x${"33".repeat(32)}`,
    agentName: "hedger",
    pythonPath: python,
    bridgePath: resolve("services/hedger/hyperliquid_bridge.py"),
    requestTimeoutMs: 5_000,
    ...options,
  });
}

const order = (market: string) => ({
  clientId: `0x${"55".repeat(32)}`,
  market,
  baseDelta: 10n ** 16n,
  limitPrice: 100_000_000_000n,
});

test("the mainnet bridge runs only on an account dedicated to the hedge coins", async () => {
  const sdk = fakeSdk(),
    mainnet = venue(sdk.python, { network: "mainnet", coins: ["BTC", "ETH"] });
  try {
    assert.equal(mainnet.mode, "hyperliquid-mainnet");
    sdk.setState({ positions: { BTC: "0.5" }, openOrders: [{ coin: "ETH" }] });
    assert.equal((await mainnet.verify()).agentName, "hedger");
    assert.equal(await mainnet.position("BTC"), 5n * 10n ** 17n);
    assert.equal((await mainnet.submit(order("ETH"))).status, "filled");
    await assert.rejects(mainnet.submit(order("SOL")), /unsupported market SOL/);

    sdk.setState({ positions: { BTC: "0.5", SOL: "3" }, openOrders: [] });
    await assert.rejects(mainnet.verify(), /positions outside the hedge markets: SOL/);
    sdk.setState({ positions: {}, openOrders: [{ coin: "SOL" }] });
    await assert.rejects(mainnet.verify(), /open orders outside the hedge markets: SOL/);
  } finally {
    await mainnet.close();
    rmSync(sdk.directory, { recursive: true, force: true });
  }
});

test("the testnet bridge keeps trading any listed perp and ignores other holdings", async () => {
  const sdk = fakeSdk(),
    testnet = venue(sdk.python, { network: "testnet" });
  try {
    assert.equal(testnet.mode, "hyperliquid-testnet");
    sdk.setState({ positions: { SOL: "3" }, openOrders: [{ coin: "SOL" }] });
    await testnet.verify();
    assert.equal((await testnet.submit(order("SOL"))).status, "filled");
  } finally {
    await testnet.close();
    rmSync(sdk.directory, { recursive: true, force: true });
  }
});

test("the mainnet venue needs its coin list before it starts a bridge", () => {
  assert.throws(() => venue("python3", { network: "mainnet" }), /coins its account may trade/);
  assert.throws(
    () => venue("python3", { network: "mainnet", coins: ["BTC;rm"] }),
    /invalid Hyperliquid coin/,
  );
  assert.throws(
    () => venue("python3", { network: "devnet" as "mainnet", coins: ["BTC"] }),
    /unknown Hyperliquid network/,
  );
});
