import { test } from "node:test";
import assert from "node:assert/strict";
import { supervise } from "./supervise.js";
test("qualification child requires success and bounds retained output", async () => {
  assert.equal(
    await supervise(process.execPath, ["-e", "process.stdout.write('x'.repeat(500))"], {
      timeoutMs: 1000,
      maxOutputBytes: 100,
    }),
    "x".repeat(100),
  );
  await assert.rejects(
    supervise(process.execPath, ["-e", "process.stderr.write('diagnostic');process.exit(2)"], {
      timeoutMs: 1000,
    }),
    /exited 2: diagnostic/,
  );
});
test("qualification deadline escalates a TERM-resistant child and descendant", async () => {
  const start = Date.now();
  await assert.rejects(
    supervise(
      process.execPath,
      [
        "-e",
        "process.on('SIGTERM',()=>{});require('node:child_process').spawn(process.execPath,['-e',\"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)\"],{stdio:'inherit'});setInterval(()=>{},1000)",
      ],
      { timeoutMs: 100, killGraceMs: 50 },
    ),
    /deadline/,
  );
  assert(Date.now() - start < 2000);
});
test("qualification interrupt stops current child and pre-aborted work never starts", async () => {
  const controller = new AbortController(),
    run = supervise(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
      timeoutMs: 1000,
      signal: controller.signal,
      killGraceMs: 50,
    });
  controller.abort();
  await assert.rejects(run, /interrupted/);
  await assert.rejects(
    supervise(process.execPath, ["-e", "process.exit(0)"], { timeoutMs: 1000, signal: controller.signal }),
    /interrupted/,
  );
});
