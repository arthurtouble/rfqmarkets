import { test } from "node:test";
import assert from "node:assert/strict";
import {
  KeeperEngine,
  type KeeperAccount,
  type KeeperDependencies,
  type KeeperState,
  type KeeperAction,
} from "./engine.js";
const address = (i: number) => `0x${i.toString(16).padStart(40, "0")}`;
function fixture() {
  const state: KeeperState = {
    resolutionRequired: false,
    resolutionPricesReady: false,
    resolutionFinalized: false,
    resolutionCursor: 0n,
    sampleCounts: [0, 0],
    priceTimes: [0, 0],
    timestamp: 100,
  };
  const actions: KeeperAction[] = [],
    cursors: Array<string | undefined> = [];
  const deps: KeeperDependencies = {
    reconcile: async () => true,
    state: async () => ({ ...state }),
    proof: async () => ({ report: "0x1234", observedAt: 100, validUntil: 130 }),
    accounts: async (cursor, limit) => {
      cursors.push(cursor);
      const begin = cursor ? Number(BigInt(cursor)) + 1 : 1;
      return {
        items: Array.from({ length: limit }, (_, i) => ({
          account: address(begin + i),
          positions: { BTC: { size: "1" }, ETH: { size: "0" } },
        })),
        nextCursor: address(begin + limit - 1),
      };
    },
    execute: async (_id, action) => {
      actions.push(action);
      if (action.kind === "incident") return false;
      if (action.kind === "refresh") state.priceTimes[action.market] = 100;
      return true;
    },
  };
  return { deps, state, actions, cursors };
}
test("keeper refreshes both legs, assesses maker capital, bounds writes and resumes pages with API absent", async () => {
  const f = fixture(),
    engine = new KeeperEngine(f.deps, { accountsPerCycle: 5, maxTransactions: 4, resolutionPage: 50 });
  await engine.cycle();
  assert.deepEqual(
    f.actions.map((a) => a.kind),
    ["refresh", "refresh", "incident", "liquidate", "liquidate"],
  );
  await engine.cycle();
  assert.equal(f.cursors[1], address(2));
  assert.equal(f.actions.length, 10);
  await engine.close();
});
test("keeper rereads state and stops financial mutations on incident", async () => {
  const f = fixture();
  f.deps.execute = async (_id, action) => {
    f.actions.push(action);
    f.state.resolutionRequired = true;
    return true;
  };
  const engine = new KeeperEngine(f.deps);
  await engine.cycle();
  assert.equal(f.actions.length, 1);
  await engine.cycle();
  assert(f.actions.slice(1).every((a) => a.kind === "sample"));
  await engine.close();
});
test("keeper enters an objectively provable maker incident before liquidations", async () => {
  const f = fixture();
  f.state.priceTimes = [100, 100];
  f.deps.execute = async (_id, action) => {
    f.actions.push(action);
    if (action.kind === "incident") {
      f.state.resolutionRequired = true;
      return true;
    }
    return false;
  };
  const engine = new KeeperEngine(f.deps);
  await engine.cycle();
  assert.deepEqual(f.actions, [{ kind: "incident" }]);
  assert.equal(f.cursors.length, 0);
  await engine.close();
});
test("keeper processes bounded resolution pages without indexer or API", async () => {
  const f = fixture();
  f.state.resolutionRequired = true;
  f.state.resolutionPricesReady = true;
  f.state.resolutionCursor = 200n;
  f.deps.accounts = async () => {
    throw new Error("API/indexer down");
  };
  const engine = new KeeperEngine(f.deps);
  await engine.cycle();
  assert.deepEqual(f.actions, [{ kind: "process", cursor: 200n, maxAccounts: 50 }]);
  f.state.resolutionFinalized = true;
  await engine.cycle();
  assert.equal(f.actions.length, 1);
  await engine.close();
});
test("replayed resolution samples cause simulation rejection without sponsor writes", async () => {
  const f = fixture();
  f.state.resolutionRequired = true;
  f.state.sampleCounts = [3, 2];
  f.deps.execute = async (_id, action) => {
    f.actions.push(action);
    return false;
  };
  const engine = new KeeperEngine(f.deps);
  await engine.cycle();
  assert.equal(f.actions.length, 1);
  assert.equal(f.actions[0].kind, "sample");
  assert.equal(engine.status().ok, true);
  await engine.close();
});
test("keeper unresolved nonce, stale proof and transport failure close health without leaking errors", async () => {
  for (const fail of ["nonce", "proof", "rpc"]) {
    const f = fixture();
    if (fail === "nonce") f.deps.reconcile = async () => false;
    if (fail === "proof") f.deps.proof = async () => ({ report: "0x", observedAt: 1, validUntil: 130 });
    if (fail === "rpc")
      f.deps.execute = async () => {
        throw new Error("https://secret:credential@rpc");
      };
    const engine = new KeeperEngine(f.deps);
    await engine.cycle();
    assert.equal(engine.status().error, "keeper_cycle_failed");
    assert.equal(engine.status().ok, false);
    assert.equal(f.actions.length, 0);
    await engine.close();
  }
});
test("keeper single-flight cycle and shutdown wait for active work and prevent new writes", async () => {
  const f = fixture();
  let release!: () => void;
  f.deps.proof = async () => {
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    return { report: "0x", observedAt: 100, validUntil: 130 };
  };
  const engine = new KeeperEngine(f.deps),
    first = engine.cycle();
  assert.equal(engine.cycle(), first);
  while (!release) await new Promise((resolve) => setImmediate(resolve));
  const closing = engine.close();
  release();
  await closing;
  assert.equal(f.actions.length, 0);
  await engine.cycle();
  assert.equal(f.actions.length, 0);
});
test("keeper reports each distinct cycle failure once and keeps public status generic", async () => {
  const f = fixture(),
    reported: unknown[] = [];
  let healthy = false;
  f.deps.reconcile = async () => healthy;
  const engine = new KeeperEngine(f.deps, undefined, (error) => reported.push(error));
  await engine.cycle();
  await engine.cycle();
  assert.equal(reported.length, 1);
  assert.match(String(reported[0]), /unresolved keeper sponsor/);
  assert.equal(engine.status().error, "keeper_cycle_failed");
  healthy = true;
  await engine.cycle();
  assert.equal(engine.status().ok, true);
  healthy = false;
  await engine.cycle();
  assert.equal(reported.length, 2, "a failure after recovery is reported again");
  await engine.close();
});
test("keeper refreshes only markets with open interest and liquidates in any registered market", async () => {
  const f = fixture();
  // A third market with no exposure and no price yet (just added by governance) must not block the keeper.
  f.state.sampleCounts = [0, 0, 0];
  f.state.priceTimes = [100, 0, 0];
  f.state.openInterest = [true, false, false];
  f.deps.accounts = async () => ({
    items: [
      {
        account: address(1),
        positions: { BTC: { size: "0" }, ETH: { size: "0" }, "market #2": { size: "-5" } },
      },
    ],
    nextCursor: null,
  });
  const engine = new KeeperEngine(f.deps);
  await engine.cycle();
  assert.deepEqual(
    f.actions.map((action) => `${action.kind}${"market" in action ? `:${action.market}` : ""}`),
    ["incident", "liquidate:2"],
  );
  assert.equal(engine.status().ok, true);
  await engine.close();
});
test("idle markets cannot starve liquidations: refreshes are bounded, rotate and reserve writes", async () => {
  const f = fixture();
  // Six markets with open interest, none priced recently; accounts hold BTC only.
  f.state.sampleCounts = [0, 0, 0, 0, 0, 0];
  f.state.priceTimes = [0, 0, 0, 0, 0, 0];
  f.deps.proof = async () => ({
    report: "0x1234",
    observedAt: f.state.timestamp,
    validUntil: f.state.timestamp + 30,
  });
  f.deps.execute = async (_id, action) => {
    f.actions.push(action);
    if (action.kind === "incident") return false;
    if (action.kind === "refresh") f.state.priceTimes[action.market] = f.state.timestamp;
    return true;
  };
  // Digit-only addresses keep checksummed order equal to numeric order across many pages.
  f.deps.accounts = async (cursor, limit) => {
    const begin = cursor ? Number(cursor) + 1 : 1;
    return {
      items: Array.from({ length: limit }, (_, i) => ({
        account: `0x${String(begin + i).padStart(40, "0")}`,
        positions: { BTC: { size: "1" } },
      })),
      nextCursor: `0x${String(begin + limit - 1).padStart(40, "0")}`,
    };
  };
  const engine = new KeeperEngine(f.deps, { accountsPerCycle: 5, maxTransactions: 4, resolutionPage: 50 });
  const kinds = () =>
    f.actions.map((action) => `${action.kind}${"market" in action ? `:${action.market}` : ""}`);
  const cycle = async (timestamp: number) => {
    f.actions.length = 0;
    f.state.timestamp = timestamp;
    await engine.cycle();
    return kinds();
  };
  // Half the writes refresh, starting one market further on each cycle; liquidations always get the rest.
  assert.deepEqual(await cycle(100), ["refresh:0", "refresh:1", "liquidate:0", "liquidate:0"]);
  assert.equal(engine.status().ok, true, "an assessment still pending is not yet a failure");
  assert.deepEqual(await cycle(102), ["refresh:2", "refresh:3", "liquidate:0", "liquidate:0"]);
  // Every market is now fresh enough to assess maker capital.
  assert.deepEqual(await cycle(104), ["refresh:4", "refresh:5", "incident", "liquidate:0", "liquidate:0"]);
  // Until the next sweep is due nothing is refreshed: liquidations take every write.
  assert.deepEqual(await cycle(110), [
    "incident",
    "liquidate:0",
    "liquidate:0",
    "liquidate:0",
    "liquidate:0",
  ]);
  assert.deepEqual(await cycle(125), ["liquidate:0", "liquidate:0", "liquidate:0", "liquidate:0"]);
  assert.deepEqual((await cycle(140)).slice(0, 2), ["refresh:3", "refresh:4"]);
  await engine.close();
});

test("only the legs a liquidation depends on are refreshed, and a blocked account is retried", async () => {
  const f = fixture();
  f.state.sampleCounts = [0, 0, 0];
  f.state.priceTimes = [100, 100, 100];
  f.deps.proof = async () => ({
    report: "0x1234",
    observedAt: f.state.timestamp,
    validUntil: f.state.timestamp + 30,
  });
  f.deps.accounts = async (cursor) => ({
    items: (
      [
        { account: address(1), positions: { BTC: { size: "1" } } },
        { account: address(2), positions: { BTC: { size: "1" }, "market #2": { size: "-1" } } },
      ] as KeeperAccount[]
    ).filter((item) => !cursor || item.account > cursor),
    nextCursor: null,
  });
  f.deps.execute = async (_id, action) => {
    f.actions.push(action);
    if (action.kind === "refresh") f.state.priceTimes[action.market] = f.state.timestamp;
    return action.kind !== "incident";
  };
  const engine = new KeeperEngine(f.deps, { accountsPerCycle: 5, maxTransactions: 2, resolutionPage: 50 });
  const label = (action: KeeperAction) =>
    `${action.kind}${"market" in action ? `:${action.market}` : ""}${"account" in action ? `:${Number(action.account)}` : ""}`;
  await engine.cycle();
  assert.deepEqual(f.actions.map(label), ["incident", "liquidate:0:1", "liquidate:0:2"]);
  // Twenty seconds on, before the next sweep: BTC is refreshed by each liquidation's own proof and ETH is held by
  // nobody, so only market #2 (account 2's other leg) needs a refresh. After account 1 only one write is left,
  // which the liquidation itself would need, so account 2 is set aside and retried first next cycle.
  f.actions.length = 0;
  f.state.timestamp = 120;
  await engine.cycle();
  assert.deepEqual(f.actions.map(label), ["liquidate:0:1"]);
  f.actions.length = 0;
  await engine.cycle();
  assert.deepEqual(f.actions.map(label), ["refresh:2", "liquidate:0:2"]);
  await engine.close();
});

test("a maker capital assessment that stays impossible fails the keeper's health", async () => {
  const f = fixture();
  f.state.sampleCounts = [0, 0, 0, 0];
  f.state.priceTimes = [0, 0, 0, 0];
  f.deps.accounts = async () => ({ items: [], nextCursor: null });
  // Refreshes never land (for example every proof's simulation reverts).
  f.deps.execute = async (_id, action) => {
    f.actions.push(action);
    return false;
  };
  const engine = new KeeperEngine(f.deps);
  await engine.cycle();
  assert.equal(engine.status().ok, true);
  f.state.timestamp = 100 + 121;
  await engine.cycle();
  assert.equal(engine.status().error, "keeper_cycle_failed");
  await engine.close();
});

test("an account with more stale legs than one cycle can refresh does not pin the cursor", async () => {
  const f = fixture();
  f.state.sampleCounts = [0, 0, 0, 0, 0, 0, 0, 0];
  f.state.priceTimes = [200, 200, 200, 200, 200, 200, 200, 200];
  f.state.timestamp = 200;
  f.deps.proof = async () => ({
    report: "0x1234",
    observedAt: f.state.timestamp,
    validUntil: f.state.timestamp + 30,
  });
  const many: Record<string, { size: string }> = { BTC: { size: "1" } };
  for (let market = 2; market < 8; market++) many[`market #${market}`] = { size: "1" };
  let pages = 0;
  f.deps.accounts = async (cursor) => {
    pages++;
    return {
      items: (
        [
          { account: address(1), positions: many },
          { account: address(2), positions: { BTC: { size: "1" } } },
          { account: address(3), positions: { BTC: { size: "1" } } },
        ] as KeeperAccount[]
      ).filter((item) => !cursor || item.account > cursor),
      nextCursor: null,
    };
  };
  f.deps.execute = async (_id, action) => {
    f.actions.push(action);
    if (action.kind === "refresh") f.state.priceTimes[action.market] = f.state.timestamp;
    return action.kind !== "incident";
  };
  const engine = new KeeperEngine(f.deps, { accountsPerCycle: 5, maxTransactions: 4, resolutionPage: 50 });
  const label = (action: KeeperAction) =>
    `${action.kind}${"market" in action ? `:${action.market}` : ""}${"account" in action ? `:${Number(action.account)}` : ""}`;
  await engine.cycle();
  // Before the next sweep, every price is 25 s old: account 1's six other legs need refreshes.
  f.state.timestamp = 225;
  f.actions.length = 0;
  await engine.cycle();
  // Account 1 may spend all but one write on its legs; still stale, it is set aside and later accounts proceed.
  assert.deepEqual(f.actions.map(label), ["refresh:2", "refresh:3", "refresh:4", "liquidate:0:2"]);
  f.state.timestamp = 227;
  f.actions.length = 0;
  await engine.cycle();
  // Retried first: the other three legs, and with every leg fresh the last write liquidates it.
  assert.deepEqual(f.actions.map(label), ["refresh:5", "refresh:6", "refresh:7", "liquidate:0:1"]);
  f.state.timestamp = 229;
  f.actions.length = 0;
  await engine.cycle();
  assert.equal(f.actions.map(label)[0], "liquidate:0:3", "the scan carried on past account 1");
  assert(pages >= 3);
  await engine.close();
});
