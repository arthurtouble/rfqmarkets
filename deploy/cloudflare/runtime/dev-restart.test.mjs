import test from "node:test";
import assert from "node:assert/strict";
import { needsRestart } from "./dev-restart.mjs";

const deployment = {
  contracts: { clearingProxy: "0xAaAa000000000000000000000000000000000001" },
  oracle: { signers: ["0xBb00000000000000000000000000000000000001"], threshold: 2 },
};
const running = {
  phase: "running",
  clearing: "0xaaaa000000000000000000000000000000000001",
  oracle: { signers: ["0xbb00000000000000000000000000000000000001"], threshold: 2 },
};

test("a running stack on the same proxy and oracle signers keeps running", () => {
  assert.equal(needsRestart(running, deployment), false);
  assert.equal(needsRestart({ phase: "waiting" }, deployment), false);
});

test("a crash, a new proxy or a new oracle signer set restarts the stack", () => {
  assert.equal(needsRestart({ ...running, phase: "exited" }, deployment), true);
  assert.equal(needsRestart({ ...running, clearing: "0x01" }, deployment), true);
  assert.equal(
    needsRestart(
      { ...running, oracle: { signers: ["0xcc00000000000000000000000000000000000001"], threshold: 2 } },
      deployment,
    ),
    true,
  );
  assert.equal(needsRestart({ ...running, oracle: { ...running.oracle, threshold: 1 } }, deployment), true);
  assert.equal(needsRestart({ phase: "running", clearing: running.clearing }, deployment), true);
});
