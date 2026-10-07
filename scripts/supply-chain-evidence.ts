import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import { identifyCandidate } from "./candidate-identity.js";

const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/),
  hash = z.string().regex(/^[a-f0-9]{64}$/);
export const supplyChainEvidenceSchema = z
  .object({
    version: z.literal(1),
    candidateHash: hash,
    generatedAt: z.string().datetime(),
    baseImage: z.object({ reference: z.string().min(1), digest: digest }).strict(),
    hostImageDigest: digest,
    locks: z.object({ npm: hash, python: hash }).strict(),
    components: z
      .array(
        z
          .object({
            ecosystem: z.enum(["npm", "pypi"]),
            name: z.string().min(1),
            version: z.string().min(1),
            integrity: z.string().min(1),
          })
          .strict(),
      )
      .min(1),
  })
  .strict();
const sha = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");

export function createSupplyChainEvidence(root: string, hostImageDigest: string) {
  digest.parse(hostImageDigest);
  const { candidateHash } = identifyCandidate(root),
    docker = readFileSync(resolve(root, "Dockerfile.host"), "utf8"),
    from = docker.match(/^FROM(?:\s+--platform=\S+)?\s+(\S+)@((?:sha256:)[a-f0-9]{64})$/m);
  if (!from) throw new Error("Host Dockerfile base image is not digest pinned");
  const packageLockBytes = readFileSync(resolve(root, "package-lock.json")),
    packageLock = JSON.parse(packageLockBytes.toString()) as {
      packages: Record<string, { name?: string; version?: string; integrity?: string; dev?: boolean }>;
    },
    pythonBytes = readFileSync(resolve(root, "services/hedger/requirements.lock")),
    components: Array<{ ecosystem: "npm" | "pypi"; name: string; version: string; integrity: string }> = [];
  for (const [path, item] of Object.entries(packageLock.packages)) {
    if (!path || item.dev === true || !item.version || !item.integrity) continue;
    const name = item.name ?? path.slice(path.lastIndexOf("node_modules/") + 13);
    components.push({ ecosystem: "npm", name, version: item.version, integrity: item.integrity });
  }
  for (const line of pythonBytes.toString().split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z0-9_.-]+)==([^ ]+) --hash=(sha256:[a-f0-9]{64})$/);
    if (match) components.push({ ecosystem: "pypi", name: match[1], version: match[2], integrity: match[3] });
    else if (line.trim() && !line.startsWith("#"))
      throw new Error("Python lock contains an unhashed or unpinned entry");
  }
  components.sort((a, b) => `${a.ecosystem}:${a.name}`.localeCompare(`${b.ecosystem}:${b.name}`));
  return supplyChainEvidenceSchema.parse({
    version: 1,
    candidateHash,
    generatedAt: new Date().toISOString(),
    baseImage: { reference: from[1], digest: from[2] },
    hostImageDigest,
    locks: { npm: sha(packageLockBytes), python: sha(pythonBytes) },
    components,
  });
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
  const output = resolve(process.argv[2] ?? ""),
    image = process.argv[3];
  if (!process.argv[2] || !image)
    throw new Error("Usage: supply-chain-evidence OUTPUT HOST_IMAGE_SHA256_DIGEST");
  if (existsSync(output)) throw new Error("Evidence destination already exists");
  writeFileSync(output, JSON.stringify(createSupplyChainEvidence(process.cwd(), image), null, 2) + "\n", {
    mode: 0o600,
  });
}
