import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { checkReleaseEvidence } from "./release-evidence.js";
import { candidateHash as hashCandidate } from "./candidate-identity.js";
test("release review requires complete source, exact audit identity and sustained successful evidence", () => {
  const root = mkdtempSync(join(tmpdir(), "rfq-release-"));
  try {
    mkdirSync(join(root, "contracts"));
    mkdirSync(join(root, "services/hedger"), { recursive: true });
    const put = (path: string, text: string) => {
      writeFileSync(join(root, path), text);
      return { path, sha256: createHash("sha256").update(text).digest("hex") };
    };
    const candidate = [
        put("contracts/Clearing.sol", "candidate"),
        put("package-lock.json", "{}"),
        put("services/hedger/requirements.lock", "sdk==1 --hash=sha256:" + "1".repeat(64)),
        put("Dockerfile.host", "FROM node@sha256:" + "2".repeat(64)),
      ],
      candidateHash = hashCandidate(candidate),
      proof = put("review.md", "external evidence");
    const supplyChain = put(
      "supply.json",
      JSON.stringify({
        version: 1,
        candidateHash,
        generatedAt: new Date().toISOString(),
        baseImage: { reference: "node", digest: "sha256:" + "2".repeat(64) },
        hostImageDigest: "sha256:" + "3".repeat(64),
        locks: { npm: candidate[1].sha256, python: candidate[2].sha256 },
        components: [{ ecosystem: "pypi", name: "sdk", version: "1", integrity: "sha256:" + "1".repeat(64) }],
      }),
    );
    const results = Array.from({ length: 2 }, (_, i) => ({
      evidence: { verified: true, market: i ? "ETH" : "BTC" },
    }));
    const soak = put(
      "soak.json",
      JSON.stringify({
        version: 3,
        candidateHash,
        finalCandidateHash: candidateHash,
        deploymentHash: "1".repeat(64),
        finalDeploymentHash: "1".repeat(64),
        status: "completed",
        failures: 0,
        requestedHours: 72,
        elapsedMs: 72 * 3600000,
        completed: 1,
        results,
      }),
    );
    const input = {
      version: 2,
      chainId: "8453",
      candidate,
      work: Array.from({ length: 16 }, (_, i) => ({ id: `R${i + 1}`, status: "verified", evidence: proof })),
      soak,
      supplyChain,
      audits: ["contracts", "services", "operations"].map((scope) => ({
        reviewer: "independent",
        scope,
        candidateHash,
        report: proof,
      })),
    };
    assert.equal(checkReleaseEvidence(input, root).readyForDeploymentReview, true);
    assert.throws(() => checkReleaseEvidence({ ...input, work: input.work.slice(1) }, root));
    put("contracts/Omitted.sol", "not reviewed");
    assert.throws(() => checkReleaseEvidence(input, root), /omits/);
    rmSync(join(root, "contracts/Omitted.sol"));
    assert.throws(
      () =>
        checkReleaseEvidence(
          { ...input, audits: input.audits.map((a) => ({ ...a, candidateHash: "0".repeat(64) })) },
          root,
        ),
      /another candidate/,
    );
    const short = put(
      "short.json",
      JSON.stringify({
        version: 3,
        candidateHash,
        finalCandidateHash: candidateHash,
        deploymentHash: "1".repeat(64),
        finalDeploymentHash: "1".repeat(64),
        status: "completed",
        failures: 0,
        requestedHours: 72,
        elapsedMs: 3600000,
        completed: 1,
        results,
      }),
    );
    assert.throws(() => checkReleaseEvidence({ ...input, soak: short }, root), /72-hour/);
    const mismatched = put(
      "mismatched.json",
      JSON.stringify({
        version: 3,
        status: "completed",
        failures: 0,
        requestedHours: 72,
        elapsedMs: 72 * 3600000,
        completed: 1,
        results,
        candidateHash: "0".repeat(64),
      }),
    );
    assert.throws(() => checkReleaseEvidence({ ...input, soak: mismatched }, root), /unchanged reviewed/);
    put("hardhat.config.js", "unreviewed build config");
    assert.throws(() => checkReleaseEvidence(input, root), /omits/);
    rmSync(join(root, "hardhat.config.js"));
    put("contracts/Clearing.sol", "changed");
    assert.throws(() => checkReleaseEvidence(input, root), /checksum/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
