import { test } from "node:test";
import assert from "node:assert/strict";
import { Interface } from "ethers";
import { settlementEvent } from "./settlement-event.js";
import { clearingApiAbi } from "../../../packages/shared/src/abi.js";
test("inclusion and unrelated logs cannot establish an authorized fill", async () => {
  const address = "0x0000000000000000000000000000000000000001",
    account = "0x0000000000000000000000000000000000000002",
    iface = new Interface(clearingApiAbi),
    intentHash = "0x" + "11".repeat(32),
    fill = [intentHash, account, 0, 1n, 1n, 0n, 0n, 1n, 1n],
    event = iface.encodeEventLog(
      "TradeExecuted(bytes32,address,uint8,int256,uint256,uint256,int256,int256,uint256)",
      fill,
    ),
    legacy = iface.encodeEventLog(
      "TradeExecuted(bytes32,address,uint8,int256,uint256,uint256)",
      fill.slice(0, 6),
    );
  let logs: Array<{ address: string; topics: string[]; data: string }> = [];
  const provider = { send: async () => ({ status: "0x1", logs }) };
  const check = () =>
    settlementEvent(
      provider,
      address,
      iface,
      "0xhash",
      "TradeExecuted",
      (args) => args.intentHash === intentHash,
    );
  assert.equal(await check(), false);
  logs = [{ address: account, ...event }];
  assert.equal(await check(), false);
  logs = [{ address, ...event }];
  assert.equal(await check(), true);
  logs = [{ address, ...legacy }];
  assert.equal(await check(), true, "fills from before the upgrade still match");
  assert.equal(await settlementEvent(provider, address, iface, "0xhash", "Withdrawn", () => true), false);
  assert.equal(
    await settlementEvent(provider, address, iface, "0xhash", "TradeExecuted", () => false),
    false,
  );
});

test("a receipt the sender saw but the next RPC node lacks is asked for again", async () => {
  const address = "0x0000000000000000000000000000000000000001",
    account = "0x0000000000000000000000000000000000000002",
    iface = new Interface(clearingApiAbi),
    event = iface.encodeEventLog("Deposited(address,uint256)", [account, 5n]);
  let calls = 0;
  const lagging = { send: async () => (++calls < 3 ? null : { status: "0x1", logs: [{ address, ...event }] }) };
  assert.equal(
    await settlementEvent(lagging, address, iface, "0xhash", "Deposited", () => true, { pollMs: 1 }),
    true,
  );
  assert.equal(calls, 3);
  const missing = { send: async () => null };
  assert.equal(
    await settlementEvent(missing, address, iface, "0xhash", "Deposited", () => true, { waitMs: 20, pollMs: 1 }),
    false,
  );
});
