// Runs the scripted end-to-end scenarios against a running `npm run dev:stack`.
// Each scenario signs real EIP-712 messages, gets a 2-of-3 approver quorum and settles on the local chain.
import { spawnSync } from "node:child_process";

const scenarios = [
  ["smoke:local", "deposit, withdrawal, cancellation, session key and a sponsored fill"],
  ["smoke:funds", "approve and deposit, first-deposit floor, sponsored withdrawals and their limits"],
  ["smoke:approver-outage", "one approver down still settles; two down fails closed"],
  ["smoke:failover", "leader epoch failover fences old approvals"],
] as const;
const only = process.argv[2];
const selected = only ? scenarios.filter(([name]) => name === only || name === `smoke:${only}`) : scenarios;
if (selected.length === 0)
  throw new Error(`unknown scenario ${only}; choose from ${scenarios.map(([name]) => name).join(", ")}`);
let failed = 0;
for (const [script, summary] of selected) {
  console.log(`\n▶ ${script}: ${summary}`);
  const result = spawnSync("npm", ["run", "--silent", script], { stdio: "inherit" });
  if (result.status !== 0) {
    failed++;
    console.error(`✖ ${script} failed`);
  }
}
if (failed) {
  console.error(`\n${failed} of ${selected.length} scenarios failed`);
  process.exit(1);
}
console.log(`\nAll ${selected.length} scenarios passed`);
