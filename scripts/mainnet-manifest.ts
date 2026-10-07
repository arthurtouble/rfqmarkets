import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { getAddress } from "ethers";
import { z } from "zod";
import { identifyCandidate } from "./candidate-identity.js";

const address = z
    .string()
    .regex(/^0x[0-9a-fA-F]{40}$/)
    .transform(getAddress),
  hash = z.string().regex(/^[a-f0-9]{64}$/),
  amount = z
    .string()
    .regex(/^[1-9][0-9]*$/)
    .transform(BigInt);
const int = (min: number, max: number) => z.number().int().min(min).max(max);
// Launch risk parameters (see ECONOMIC-SPECIFICATION.md); bounds match RFQClearing._validateRisk.
export const LAUNCH_RISK = {
  BTC: { impactK: 10_000, shockBps: 4_000, marginScaleBps: 10_000 },
  ETH: { impactK: 12_000, shockBps: 5_000, marginScaleBps: 10_000 },
} as const;
const risk = (defaults: { impactK: number; shockBps: number; marginScaleBps: number }) => ({
  impactK: int(1, 1_000_000).default(defaults.impactK),
  shockBps: int(500, 10_000).default(defaults.shockBps),
  marginScaleBps: int(2_500, 50_000).default(defaults.marginScaleBps),
});
// SignedPriceOracle consensus parameters; bounds match the oracle's constructor checks.
const oracleParams = z
  .object({
    maxDeviationBps: int(1, 1_000).default(50),
    maxSkew: int(0, 15).default(5),
    maxJumpBps: int(0, 10_000).default(0),
    jumpWindow: int(0, 86_400).default(0),
  })
  .strict()
  .default({});
const oracleSigners = z.array(address).min(3).max(16);

/** Majority threshold, distinct signers, and a jump guard that is either fully on or fully off. */
function checkOracle(
  value: {
    oracleSigners: string[];
    oracleThreshold: number;
    oracle: { maxJumpBps: number; jumpWindow: number };
  },
  label: string,
) {
  const count = value.oracleSigners.length;
  if (new Set(value.oracleSigners.map((item) => item.toLowerCase())).size !== count)
    throw new Error(`${label} oracle signers must be distinct`);
  if (value.oracleThreshold * 2 <= count || value.oracleThreshold > count)
    throw new Error(`${label} oracle threshold must be a majority of the ${count} signers`);
  if ((value.oracle.maxJumpBps === 0) !== (value.oracle.jumpWindow === 0))
    throw new Error(`${label} oracle jump guard needs both maxJumpBps and jumpWindow, or neither`);
}

const market = (defaults: { impactK: number; shockBps: number; marginScaleBps: number }) =>
  z
    .object({
      enabled: z.literal(true),
      maxTradeUsdc: amount,
      grossUsdc: amount,
      sideUsdc: amount,
      netUsdc: amount,
      hedgeBandUsdc: amount,
      ...risk(defaults),
    })
    .strict();
export const mainnetManifestSchema = z
  .object({
    version: z.literal(1),
    mode: z.literal("capped-canary"),
    chainId: z.literal("8453"),
    candidateHash: hash,
    usdc: address,
    oracleSigners,
    oracleThreshold: z.number().int().min(1),
    oracle: oracleParams,
    governance: address,
    governanceSafe: address,
    emergencyCouncil: address,
    approvers: z.tuple([address, address, address]),
    policy: z
      .object({
        makerCapitalUsdc: amount,
        insuranceCapitalUsdc: amount,
        dailyLossLimitUsdc: amount,
        timelockSeconds: z.number().int().min(259200),
        markets: z.object({ BTC: market(LAUNCH_RISK.BTC), ETH: market(LAUNCH_RISK.ETH) }).strict(),
      })
      .strict(),
  })
  .strict();

export function validateMainnetManifest(input: unknown) {
  const value = mainnetManifestSchema.parse(input),
    officialBaseUsdc = getAddress("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913");
  if (value.usdc !== officialBaseUsdc) throw new Error("Base mainnet USDC address mismatch");
  checkOracle(value, "Mainnet");
  const roles = [
    value.usdc,
    ...value.oracleSigners,
    value.governance,
    value.governanceSafe,
    value.emergencyCouncil,
    ...value.approvers,
  ];
  if (new Set(roles.map((item) => item.toLowerCase())).size !== roles.length)
    throw new Error("Mainnet roles must be distinct");
  if (value.policy.insuranceCapitalUsdc * 4n < value.policy.makerCapitalUsdc)
    throw new Error("Insurance capital must be at least 25% of maker capital");
  if (value.policy.dailyLossLimitUsdc * 20n > value.policy.makerCapitalUsdc)
    throw new Error("Daily loss limit must be at most 5% of maker capital");
  for (const [name, item] of Object.entries(value.policy.markets)) {
    if (
      item.maxTradeUsdc > item.netUsdc ||
      item.maxTradeUsdc > 1_000_000_000_000n ||
      item.grossUsdc > 5_000_000_000_000n
    )
      throw new Error(`${name} caps exceed the clearing contract bounds`);
    if (
      item.maxTradeUsdc * 10n > item.grossUsdc ||
      item.sideUsdc > item.grossUsdc ||
      item.netUsdc > item.grossUsdc ||
      item.hedgeBandUsdc * 20n > item.grossUsdc
    )
      throw new Error(`${name} canary limits are not conservative`);
  }
  return value;
}

export function createMainnetDeploymentPlan(input: unknown, root = process.cwd()) {
  const manifest = validateMainnetManifest(input),
    candidate = identifyCandidate(root);
  if (candidate.candidateHash !== manifest.candidateHash)
    throw new Error("Mainnet manifest does not match the current candidate");
  return {
    version: 1,
    kind: "unsigned-mainnet-deployment-plan",
    candidateHash: candidate.candidateHash,
    chainId: manifest.chainId,
    mode: manifest.mode,
    preconditions: [
      "release-evidence-v2 passes",
      "independent contracts/services/operations reviews match candidate",
      "72-hour soak matches candidate and deployment",
      "governance and emergency Safe ceremony complete",
      "oracle node keys generated and held by independent operators",
      "deployer balance and nonce reviewed immediately before execution",
    ],
    deploymentOrder: [
      "RFQRiskMath",
      "RFQSignatureVerifier",
      "RFQSettlement",
      "RFQLiquidation",
      "RFQResolution",
      "RFQClearing implementation",
      "SignedPriceOracle (owned by governance)",
      "TransparentUpgradeableProxy (initialized paused with the canary caps)",
      "SignedPriceOracle.setClearing(proxy) through the timelocked go-live batch",
    ],
    initialization: {
      usdc: manifest.usdc,
      oracleSigners: manifest.oracleSigners,
      oracleThreshold: manifest.oracleThreshold,
      oracle: manifest.oracle,
      governance: manifest.governance,
      governanceSafe: manifest.governanceSafe,
      emergencyCouncil: manifest.emergencyCouncil,
      approvers: manifest.approvers,
      makerCapitalUsdc: manifest.policy.makerCapitalUsdc.toString(),
    },
    policy: {
      ...manifest.policy,
      makerCapitalUsdc: manifest.policy.makerCapitalUsdc.toString(),
      insuranceCapitalUsdc: manifest.policy.insuranceCapitalUsdc.toString(),
      dailyLossLimitUsdc: manifest.policy.dailyLossLimitUsdc.toString(),
      markets: Object.fromEntries(
        Object.entries(manifest.policy.markets).map(([name, item]) => [
          name,
          Object.fromEntries(
            Object.entries(item).map(([key, value]) => [
              key,
              typeof value === "bigint" ? value.toString() : value,
            ]),
          ),
        ]),
      ),
    },
    executionAuthorized: false,
  };
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
  const source = process.argv[2],
    output = process.argv[3];
  if (!source || !output) throw new Error("Usage: mainnet-manifest MANIFEST_JSON OUTPUT_PLAN_JSON");
  if (existsSync(output)) throw new Error("Deployment plan destination already exists");
  const plan = createMainnetDeploymentPlan(JSON.parse(readFileSync(source, "utf8")));
  writeFileSync(output, JSON.stringify(plan, null, 2) + "\n", { mode: 0o600 });
}

// Development profile on Base mainnet: owner-controlled, no timelock, hard-capped so test money stays small.
// Production launches use the capped-canary manifest above on a fresh deployment.
export const DEV_CEILINGS = {
  makerCapitalUsdc: 50_000_000_000n,
  maxTradeUsdc: 1_000_000_000n,
  netUsdc: 5_000_000_000n,
  grossUsdc: 10_000_000_000n,
};
const devMarket = (defaults: { impactK: number; shockBps: number; marginScaleBps: number }) =>
  z
    .object({ maxTradeUsdc: amount, netUsdc: amount, grossUsdc: amount, sideUsdc: amount, ...risk(defaults) })
    .strict();
export const devManifestSchema = z
  .object({
    version: z.literal(1),
    mode: z.literal("dev"),
    chainId: z.literal("8453"),
    usdc: address,
    oracleSigners,
    oracleThreshold: z.number().int().min(1),
    oracle: oracleParams,
    owner: address,
    emergencyCouncil: address,
    approvers: z.tuple([address, address, address]),
    policy: z
      .object({
        makerCapitalUsdc: amount,
        markets: z.object({ BTC: devMarket(LAUNCH_RISK.BTC), ETH: devMarket(LAUNCH_RISK.ETH) }).strict(),
      })
      .strict(),
  })
  .strict();

export function validateDevManifest(input: unknown) {
  const value = devManifestSchema.parse(input);
  if (value.usdc !== getAddress("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"))
    throw new Error("Base mainnet USDC address mismatch");
  checkOracle(value, "Dev");
  const roles = [value.usdc, ...value.oracleSigners, value.owner, value.emergencyCouncil, ...value.approvers];
  if (new Set(roles.map((item) => item.toLowerCase())).size !== roles.length)
    throw new Error("Dev roles must be distinct");
  if (value.policy.makerCapitalUsdc > DEV_CEILINGS.makerCapitalUsdc)
    throw new Error("Dev maker capital floor exceeds the 50,000 USDC dev ceiling");
  for (const [name, item] of Object.entries(value.policy.markets)) {
    if (
      item.maxTradeUsdc > DEV_CEILINGS.maxTradeUsdc ||
      item.netUsdc > DEV_CEILINGS.netUsdc ||
      item.grossUsdc > DEV_CEILINGS.grossUsdc
    )
      throw new Error(`${name} caps exceed the dev ceiling (1,000 per trade, 5,000 net, 10,000 gross USDC)`);
    if (item.maxTradeUsdc > item.netUsdc || item.netUsdc > item.grossUsdc || item.sideUsdc > item.grossUsdc)
      throw new Error(`${name} caps must satisfy maxTrade <= net <= gross and side <= gross`);
  }
  // The contract has one governance address; in the dev profile it is the owner EOA, which also owns the ProxyAdmin and the oracle.
  return { ...value, governance: value.owner };
}
