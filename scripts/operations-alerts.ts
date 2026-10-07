import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
const unsigned = z.union([
  z.number().int().nonnegative(),
  z
    .string()
    .regex(/^[0-9]+$/)
    .transform(Number),
]);
const schema = z
  .object({
    observedAtMs: z.number().int().nonnegative(),
    api: z.object({
      ok: z.boolean(),
      unresolvedSender: z.number().int().nonnegative(),
      approvalP95Ms: unsigned,
    }),
    approvers: z.object({
      healthy: z.number().int().min(0).max(3),
      disagreements: z.number().int().nonnegative(),
    }),
    oracle: z.object({ maxAgeMs: unsigned }),
    indexer: z.object({ ok: z.boolean(), lagBlocks: z.number().int().nonnegative() }),
    keeper: z.object({ ok: z.boolean(), lastCompletedAtMs: z.number().int().nonnegative() }),
    hedger: z.object({ ok: z.boolean(), maxGapUsdc: unsigned, bandUsdc: unsigned }),
    capital: z.object({
      makerBackingUsdc: z
        .string()
        .regex(/^[0-9]+$/)
        .transform(BigInt),
      requiredFloorUsdc: z
        .string()
        .regex(/^[0-9]+$/)
        .transform(BigInt),
    }),
    sponsors: z.object({ minimumGasRunwayHours: unsigned }),
    backup: z.object({ lastSuccessfulAtMs: z.number().int().nonnegative() }),
  })
  .strict();
const configSchema = z
  .object({
    version: z.literal(1),
    thresholds: z
      .object({
        oracleAgeMs: unsigned,
        indexerLagBlocks: unsigned,
        keeperAgeMs: unsigned,
        approvalP95Ms: unsigned,
        hedgeGapMultiplierBps: unsigned,
        makerHeadroomBps: unsigned,
        gasRunwayHours: unsigned,
        backupAgeMs: unsigned,
      })
      .strict(),
  })
  .strict();
export type OperationalAlert = {
  severity: "page" | "warning";
  code: string;
  value: string;
  threshold: string;
};
export function evaluateOperationalAlerts(snapshotInput: unknown, configInput: unknown) {
  const snapshot = schema.parse(snapshotInput),
    config = configSchema.parse(configInput),
    t = config.thresholds,
    alerts: OperationalAlert[] = [];
  const add = (
    severity: OperationalAlert["severity"],
    code: string,
    value: number | bigint,
    threshold: number | bigint,
  ) => alerts.push({ severity, code, value: String(value), threshold: String(threshold) });
  if (!snapshot.api.ok) add("page", "api_unhealthy", 1, 0);
  if (snapshot.api.unresolvedSender > 0) add("page", "sender_unresolved", snapshot.api.unresolvedSender, 0);
  if (snapshot.api.approvalP95Ms > t.approvalP95Ms)
    add("warning", "approval_latency", snapshot.api.approvalP95Ms, t.approvalP95Ms);
  if (snapshot.approvers.healthy < 2) add("page", "approver_quorum_loss", snapshot.approvers.healthy, 2);
  if (snapshot.approvers.disagreements > 0)
    add("warning", "approval_disagreement", snapshot.approvers.disagreements, 0);
  if (snapshot.oracle.maxAgeMs > t.oracleAgeMs)
    add("page", "oracle_stale", snapshot.oracle.maxAgeMs, t.oracleAgeMs);
  if (!snapshot.indexer.ok || snapshot.indexer.lagBlocks > t.indexerLagBlocks)
    add("page", "indexer_lag", snapshot.indexer.lagBlocks, t.indexerLagBlocks);
  const keeperAge = snapshot.observedAtMs - snapshot.keeper.lastCompletedAtMs;
  if (!snapshot.keeper.ok || keeperAge > t.keeperAgeMs) add("page", "keeper_stale", keeperAge, t.keeperAgeMs);
  if (
    !snapshot.hedger.ok ||
    snapshot.hedger.maxGapUsdc * 10_000 > snapshot.hedger.bandUsdc * t.hedgeGapMultiplierBps
  )
    add(
      "page",
      "hedge_gap",
      snapshot.hedger.maxGapUsdc,
      Math.floor((snapshot.hedger.bandUsdc * t.hedgeGapMultiplierBps) / 10_000),
    );
  const required = snapshot.capital.requiredFloorUsdc,
    headroom = snapshot.capital.makerBackingUsdc - required;
  if (headroom < 0n || headroom * 10_000n < snapshot.capital.makerBackingUsdc * BigInt(t.makerHeadroomBps))
    add("page", "maker_headroom", headroom, BigInt(t.makerHeadroomBps));
  if (snapshot.sponsors.minimumGasRunwayHours < t.gasRunwayHours)
    add("page", "gas_runway", snapshot.sponsors.minimumGasRunwayHours, t.gasRunwayHours);
  const backupAge = snapshot.observedAtMs - snapshot.backup.lastSuccessfulAtMs;
  if (backupAge > t.backupAgeMs) add("page", "backup_stale", backupAge, t.backupAgeMs);
  return {
    version: 1,
    observedAtMs: snapshot.observedAtMs,
    ok: alerts.every((item) => item.severity !== "page"),
    alerts,
  };
}
if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
  const source = process.argv[2],
    output = process.argv[3],
    configPath = process.argv[4] ?? "deploy/operations/alerts.json";
  if (!source || !output) throw new Error("Usage: operations-alerts SNAPSHOT_JSON OUTPUT_JSON [CONFIG_JSON]");
  if (existsSync(output)) throw new Error("Alert output already exists");
  const result = evaluateOperationalAlerts(
    JSON.parse(readFileSync(source, "utf8")),
    JSON.parse(readFileSync(configPath, "utf8")),
  );
  writeFileSync(output, JSON.stringify(result, null, 2) + "\n", { mode: 0o600 });
  if (!result.ok) process.exitCode = 2;
}
