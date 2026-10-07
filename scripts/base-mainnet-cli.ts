import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { ContractFactory, JsonRpcProvider, Wallet, formatEther, getAddress } from "ethers";
import {
  appointRiskOperatorDev,
  configureDev,
  devPreflight,
  generateDevIdentities,
  handoverDev,
  unpauseDev,
  upgradeDev,
  verifyDev,
} from "./base-mainnet-dev.js";
import {
  BASE_MAINNET_CHAIN_ID,
  artifact,
  basescanSubmissions,
  deployCore,
  launchBatches,
  preflight,
  renounceTimelockAdminBatch,
  verifyDeployment,
  type CoreInputs,
  type DeploymentRecord,
} from "./base-mainnet.js";
import { identifyCandidate } from "./candidate-identity.js";
import { validateDevManifest, validateMainnetManifest } from "./mainnet-manifest.js";
import { checkReleaseEvidence } from "./release-evidence.js";

// Usage (see docs/operations/base-mainnet.md):
//   candidate         (prints this checkout's candidate hash for the manifest)
//   preflight         MANIFEST
//   deploy-timelock   GOVERNANCE_SAFE [DELAY_SECONDS=259200]
//   deploy            MANIFEST (--dormant | --release-evidence FILE)
//   verify            MANIFEST
//   batches           MANIFEST
//   basescan          MANIFEST
// Development profile (owner EOA, no timelock, dev-capped; state in .local-state/base-mainnet-dev):
//   dev-identities    [ORACLE_SIGNER,ORACLE_SIGNER,ORACLE_SIGNER...]
//   dev-preflight     DEV_MANIFEST
//   dev-deploy        DEV_MANIFEST [--unpause]
//   dev-configure     DEV_MANIFEST [--unpause]
//   dev-upgrade       DEV_MANIFEST
//   dev-risk-operator DEV_MANIFEST OPERATOR_ADDRESS   (after a v1.2 upgrade)
//   dev-handover      DEV_MANIFEST TIMELOCK GOVERNANCE_SAFE EMERGENCY_SAFE
//   dev-verify        DEV_MANIFEST
//   dev-basescan      DEV_MANIFEST
const STATE = resolve(process.env.RFQ_MAINNET_STATE_DIR ?? ".local-state/base-mainnet");
const RECORD = resolve(STATE, "deployment.json"),
  PARTIAL = resolve(STATE, "deployment.partial.json");
const [command, target, ...flags] = process.argv.slice(2);
const env = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
};
const rpc = (name = "RFQ_BASE_MAINNET_RPC_URL") => {
  const url = env(name);
  if (!url.startsWith("https://")) throw new Error(`${name} must use HTTPS`);
  return new JsonRpcProvider(url, undefined, { staticNetwork: false });
};
const writePrivate = (path: string, value: unknown) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  chmodSync(path, 0o600);
};
const loadManifest = () => {
  if (!target) throw new Error("MANIFEST path is required");
  const manifest = validateMainnetManifest(JSON.parse(readFileSync(resolve(target), "utf8")));
  const candidate = identifyCandidate();
  if (candidate.candidateHash !== manifest.candidateHash)
    throw new Error(
      `manifest candidate ${manifest.candidateHash.slice(0, 12)} does not match this checkout (${candidate.candidateHash.slice(0, 12)})`,
    );
  return manifest;
};
const DEV_STATE = resolve(process.env.RFQ_MAINNET_DEV_STATE_DIR ?? ".local-state/base-mainnet-dev"),
  DEV_RECORD = resolve(DEV_STATE, "deployment.json"),
  DEV_PARTIAL = resolve(DEV_STATE, "deployment.partial.json"),
  DEV_IDENTITIES = resolve(DEV_STATE, "identities.json");
const loadDevManifest = () => {
  if (!target) throw new Error("DEV_MANIFEST path is required");
  return validateDevManifest(JSON.parse(readFileSync(resolve(target), "utf8")));
};
const devOwner = (provider: JsonRpcProvider) =>
  process.env.RFQ_MAINNET_DEPLOYER_KEY
    ? deployerWallet(provider)
    : new Wallet(
        (JSON.parse(readFileSync(DEV_IDENTITIES, "utf8")) as { owner: { privateKey: string } }).owner
          .privateKey,
        provider,
      );
const loadRecord = (path = RECORD) => JSON.parse(readFileSync(path, "utf8")) as DeploymentRecord;
function writeLaunchBatches(record: DeploymentRecord, manifest: ReturnType<typeof validateMainnetManifest>) {
  const batches = launchBatches(record, manifest);
  writePrivate(resolve(STATE, "safe-batches/1-schedule-go-live.json"), batches.governanceSchedule);
  writePrivate(resolve(STATE, "safe-batches/2-execute-go-live.json"), batches.governanceGoLive);
  return batches;
}
// The deployed implementation's build is kept so each upgrade is storage-checked against what is live.
const DEPLOYED_BUILD = resolve(DEV_STATE, "build-info-deployed");
const snapshotDeployedBuild = () => {
  mkdirSync(DEPLOYED_BUILD, { recursive: true });
  copyFileSync(resolve("artifacts/build-info/rfq-build.json"), resolve(DEPLOYED_BUILD, "rfq-build.json"));
};
async function submitBasescan(record: DeploymentRecord, inputs: CoreInputs) {
  // Publishes verified source to Basescan through the Etherscan v2 API.
  const apiKey = env("RFQ_BASESCAN_API_KEY"),
    api = "https://api.etherscan.io/v2/api?chainid=8453";
  for (const item of basescanSubmissions(record, inputs)) {
    const body = new URLSearchParams({
      apikey: apiKey,
      module: "contract",
      action: "verifysourcecode",
      contractaddress: item.address,
      sourceCode: JSON.stringify(item.input),
      codeformat: "solidity-standard-json-input",
      contractname: item.contractName,
      compilerversion: item.compilerVersion,
      constructorArguements: item.constructorArguments,
    });
    const submitted = (await (await fetch(api, { method: "POST", body })).json()) as {
      status: string;
      result: string;
    };
    if (submitted.status !== "1" && !/already verified/i.test(submitted.result)) {
      console.error(`${item.step}: ${submitted.result}`);
      process.exitCode = 1;
      continue;
    }
    let result = submitted.result;
    for (let attempt = 0; attempt < 20 && submitted.status === "1"; attempt++) {
      await new Promise((done) => setTimeout(done, 3_000));
      const status = (await (
        await fetch(
          `${api}&module=contract&action=checkverifystatus&guid=${submitted.result}&apikey=${apiKey}`,
        )
      ).json()) as { result: string };
      result = status.result;
      if (!/pending/i.test(result)) break;
    }
    console.log(`${item.step} ${item.address}: ${result}`);
    if (!/pass|verified/i.test(result)) process.exitCode = 1;
  }
}
const deployerWallet = (provider: JsonRpcProvider) => new Wallet(env("RFQ_MAINNET_DEPLOYER_KEY"), provider);
// Mainnet broadcasts need a typed confirmation bound to the chain, deployer and candidate.
const confirm = (action: string, deployer: string, suffix: string) => {
  const expected = `${action}-8453-${deployer.toLowerCase()}-${suffix}`;
  if (process.env.RFQ_MAINNET_DEPLOY_CONFIRM !== expected)
    throw new Error(`refusing to broadcast. Set RFQ_MAINNET_DEPLOY_CONFIRM=${expected}`);
};
const requireMainnet = async (provider: JsonRpcProvider) => {
  const chainId = (await provider.getNetwork()).chainId;
  if (chainId !== BASE_MAINNET_CHAIN_ID)
    throw new Error(`expected Base mainnet 8453, RPC reports ${chainId}`);
};

switch (command) {
  case "candidate":
    console.log(identifyCandidate().candidateHash);
    break;
  case "preflight": {
    const manifest = loadManifest(),
      provider = rpc(),
      deployer = process.env.RFQ_MAINNET_DEPLOYER_ADDRESS
        ? getAddress(process.env.RFQ_MAINNET_DEPLOYER_ADDRESS)
        : deployerWallet(provider).address;
    const report = await preflight(provider, manifest, deployer);
    console.log(
      JSON.stringify(
        {
          ...report,
          balanceEth: formatEther(report.balanceWei),
          estimatedCostEth: formatEther(report.estimatedCostWei),
        },
        null,
        2,
      ),
    );
    break;
  }
  case "deploy-timelock": {
    if (!target) throw new Error("GOVERNANCE_SAFE address is required");
    const governanceSafe = getAddress(target),
      delaySeconds = Number(flags[0] ?? 259_200),
      provider = rpc();
    if (!Number.isInteger(delaySeconds) || delaySeconds < 259_200)
      throw new Error("timelock delay must be at least 259200 seconds (72 hours)");
    await requireMainnet(provider);
    const deployer = deployerWallet(provider);
    confirm("timelock", deployer.address, governanceSafe.slice(2, 10).toLowerCase());
    if ((await provider.getCode(governanceSafe)) === "0x")
      throw new Error("governance Safe has no code on Base mainnet");
    const item = artifact("RFQTimelock"),
      contract = await new ContractFactory(item.abi, item.bytecode, deployer).deploy(
        delaySeconds,
        governanceSafe,
      );
    const receipt = await contract.deploymentTransaction()!.wait(2);
    if (!receipt || receipt.status !== 1) throw new Error("timelock deployment failed");
    const timelock = getAddress(receipt.contractAddress!);
    writePrivate(resolve(STATE, "timelock.json"), {
      chainId: "8453",
      timelock,
      governanceSafe,
      delaySeconds,
      transaction: receipt.hash,
      gasUsed: receipt.gasUsed.toString(),
      deployedAt: new Date().toISOString(),
    });
    writePrivate(
      resolve(STATE, "safe-batches/0-renounce-timelock-admin.json"),
      renounceTimelockAdminBatch("8453", timelock, governanceSafe),
    );
    console.log(
      JSON.stringify(
        {
          timelock,
          transaction: receipt.hash,
          next: "Import safe-batches/0-renounce-timelock-admin.json into the governance Safe and execute it, then set governance to this timelock in the manifest.",
        },
        null,
        2,
      ),
    );
    break;
  }
  case "deploy": {
    const manifest = loadManifest(),
      provider = rpc(),
      deployer = deployerWallet(provider);
    if (existsSync(RECORD)) throw new Error(`${RECORD} already exists; this candidate is already deployed`);
    const evidenceIndex = flags.indexOf("--release-evidence"),
      dormant = flags.includes("--dormant");
    if (evidenceIndex >= 0 === dormant)
      throw new Error("choose exactly one launch profile: --dormant or --release-evidence FILE");
    if (evidenceIndex >= 0)
      checkReleaseEvidence(JSON.parse(readFileSync(resolve(flags[evidenceIndex + 1] ?? ""), "utf8")));
    const report = await preflight(provider, manifest, deployer.address);
    console.error(JSON.stringify({ preflight: report }, null, 2));
    confirm("deploy", deployer.address, manifest.candidateHash.slice(0, 12));
    const resume = existsSync(PARTIAL) ? JSON.parse(readFileSync(PARTIAL, "utf8")) : undefined;
    const record = await deployCore(deployer, manifest, {
      candidateHash: manifest.candidateHash,
      launchProfile: dormant ? "dormant" : "released",
      resume,
      onStep: (step, address, partial) => {
        writePrivate(PARTIAL, partial);
        console.error(`${step}: ${address}`);
      },
    });
    writePrivate(RECORD, record);
    const batches = writeLaunchBatches(record, manifest);
    console.log(
      JSON.stringify(
        {
          record,
          operations: batches.operations,
          pendingOwnerSteps: record.pendingOwnerSteps ?? [],
          next: "The clearing is paused with the manifest caps and the oracle is not yet bound (its setClearing is in the go-live batch). Run verify, then schedule go-live from the governance Safe when the runtime and oracle nodes are ready.",
        },
        null,
        2,
      ),
    );
    break;
  }
  case "verify": {
    const manifest = loadManifest(),
      record = loadRecord(),
      results = [];
    // The release checklist requires two independent RPCs; the secondary is optional only for a first look.
    for (const name of ["RFQ_BASE_MAINNET_RPC_URL", "RFQ_BASE_MAINNET_SECONDARY_RPC_URL"])
      if (process.env[name]) {
        const provider = rpc(name);
        await requireMainnet(provider);
        results.push({
          rpc: new URL(env(name)).hostname,
          ...(await verifyDeployment(provider, record, manifest)),
        });
      }
    if (results.length < 2)
      console.error(
        "warning: only one RPC verified; set RFQ_BASE_MAINNET_SECONDARY_RPC_URL to an independent provider",
      );
    console.log(JSON.stringify(results, null, 2));
    break;
  }
  case "batches": {
    const batches = writeLaunchBatches(loadRecord(), loadManifest());
    console.log(JSON.stringify(batches.operations, null, 2));
    break;
  }
  case "basescan":
    await submitBasescan(loadRecord(), loadManifest());
    break;
  case "dev-identities": {
    if (existsSync(DEV_IDENTITIES))
      throw new Error(`${DEV_IDENTITIES} already exists; refusing to overwrite keys`);
    // Oracle signer addresses as one comma-separated argument or several arguments; omitted leaves placeholders to fill in.
    const oracleSigners = [target, ...flags]
      .filter(Boolean)
      .flatMap((value) => value.split(","))
      .map((value) => value.trim())
      .filter(Boolean)
      .map((value) => getAddress(value));
    const { identities, manifest } = generateDevIdentities(oracleSigners.length ? oracleSigners : undefined);
    writePrivate(DEV_IDENTITIES, identities);
    writePrivate(resolve(DEV_STATE, "dev-manifest.json"), manifest);
    console.log(
      JSON.stringify(
        {
          owner: identities.owner.address,
          emergency: identities.emergency.address,
          approvers: identities.approvers.map((item) => item.address),
          manifest: resolve(DEV_STATE, "dev-manifest.json"),
          next: "Fund the owner address with ~0.01 ETH on Base, then run dev-preflight.",
        },
        null,
        2,
      ),
    );
    break;
  }
  case "dev-preflight": {
    const manifest = loadDevManifest(),
      provider = rpc(),
      report = await devPreflight(provider, manifest, devOwner(provider).address);
    console.log(
      JSON.stringify(
        {
          ...report,
          balanceEth: formatEther(report.balanceWei),
          estimatedCostEth: formatEther(report.estimatedCostWei),
        },
        null,
        2,
      ),
    );
    break;
  }
  case "dev-deploy": {
    const manifest = loadDevManifest(),
      provider = rpc(),
      owner = devOwner(provider),
      candidateHash = identifyCandidate().candidateHash;
    if (existsSync(DEV_RECORD))
      throw new Error(
        `${DEV_RECORD} already exists; use dev-upgrade, or move it aside to deploy a fresh dev proxy`,
      );
    console.error(
      JSON.stringify({ preflight: await devPreflight(provider, manifest, owner.address) }, null, 2),
    );
    confirm("dev-deploy", owner.address, candidateHash.slice(0, 12));
    const resume = existsSync(DEV_PARTIAL) ? JSON.parse(readFileSync(DEV_PARTIAL, "utf8")) : undefined;
    const record = await deployCore(owner, manifest, {
      candidateHash,
      launchProfile: "dev",
      resume,
      onStep: (step, address, partial) => {
        writePrivate(DEV_PARTIAL, partial);
        console.error(`${step}: ${address}`);
      },
    });
    writePrivate(DEV_RECORD, record);
    snapshotDeployedBuild();
    const unpaused = flags.includes("--unpause") ? await unpauseDev(owner, record) : null;
    console.log(
      JSON.stringify(
        { record, unpauseTransaction: unpaused, verify: await verifyDev(provider, record, manifest) },
        null,
        2,
      ),
    );
    break;
  }
  case "dev-configure": {
    const manifest = loadDevManifest(),
      provider = rpc(),
      owner = devOwner(provider),
      record = loadRecord(DEV_RECORD);
    confirm("dev-configure", owner.address, record.contracts.clearingProxy.slice(2, 10).toLowerCase());
    console.log(
      JSON.stringify(
        {
          transactions: await configureDev(owner, record, manifest, { unpause: flags.includes("--unpause") }),
          verify: await verifyDev(provider, record, manifest),
        },
        null,
        2,
      ),
    );
    break;
  }
  case "dev-upgrade": {
    // Storage layout of the new build must extend the live implementation's layout.
    if (!existsSync(resolve(DEPLOYED_BUILD, "rfq-build.json")))
      throw new Error(
        `${DEPLOYED_BUILD} is missing; cannot check storage compatibility with the live implementation`,
      );
    execFileSync(
      "npx",
      [
        "openzeppelin-upgrades-core",
        "validate",
        "artifacts/build-info",
        "--contract",
        "RFQClearing",
        "--reference",
        "build-info-deployed:RFQClearing",
        "--referenceBuildInfoDirs",
        DEPLOYED_BUILD,
        "--unsafeAllowLinkedLibraries",
      ],
      { stdio: "inherit" },
    );
    const manifest = loadDevManifest(),
      provider = rpc(),
      owner = devOwner(provider),
      candidateHash = identifyCandidate().candidateHash;
    await requireMainnet(provider);
    confirm("dev-upgrade", owner.address, candidateHash.slice(0, 12));
    const record = await upgradeDev(owner, loadRecord(DEV_RECORD), { candidateHash });
    writePrivate(DEV_RECORD, record);
    snapshotDeployedBuild();
    console.log(
      JSON.stringify(
        { upgrade: record.upgrades!.at(-1), verify: await verifyDev(provider, record, manifest) },
        null,
        2,
      ),
    );
    break;
  }
  case "dev-risk-operator": {
    const operator = flags[0];
    if (!operator) throw new Error("usage: dev-risk-operator DEV_MANIFEST OPERATOR_ADDRESS");
    const manifest = loadDevManifest(),
      provider = rpc(),
      owner = devOwner(provider),
      record = loadRecord(DEV_RECORD);
    await requireMainnet(provider);
    confirm("dev-risk-operator", owner.address, operator.slice(2, 10).toLowerCase());
    console.log(
      JSON.stringify(
        {
          transactions: await appointRiskOperatorDev(owner, record, operator),
          verify: await verifyDev(provider, record, manifest),
        },
        null,
        2,
      ),
    );
    break;
  }
  case "dev-verify": {
    const manifest = loadDevManifest(),
      record = loadRecord(DEV_RECORD),
      results = [];
    for (const name of ["RFQ_BASE_MAINNET_RPC_URL", "RFQ_BASE_MAINNET_SECONDARY_RPC_URL"])
      if (process.env[name]) {
        const provider = rpc(name);
        await requireMainnet(provider);
        results.push({ rpc: new URL(env(name)).hostname, ...(await verifyDev(provider, record, manifest)) });
      }
    console.log(JSON.stringify(results, null, 2));
    break;
  }
  case "dev-handover": {
    const manifest = loadDevManifest(),
      [timelock, governanceSafe, emergencySafe] = flags.map((value) => getAddress(value));
    if (!emergencySafe)
      throw new Error("usage: dev-handover DEV_MANIFEST TIMELOCK GOVERNANCE_SAFE EMERGENCY_SAFE");
    const provider = rpc(),
      owner = devOwner(provider),
      record = loadRecord(DEV_RECORD);
    await requireMainnet(provider);
    await verifyDev(provider, record, manifest);
    confirm("dev-handover", owner.address, timelock.slice(2, 10).toLowerCase());
    const result = await handoverDev(owner, record, {
      timelock,
      governanceSafe,
      emergencySafe,
      minimumDelaySeconds: 259_200,
    });
    writePrivate(resolve(DEV_STATE, "safe-batches/handover-1-schedule-accept.json"), result.acceptSchedule);
    writePrivate(resolve(DEV_STATE, "safe-batches/handover-2-execute-accept.json"), result.acceptExecute);
    writePrivate(DEV_RECORD, {
      ...record,
      governanceSafe,
      emergencyCouncil: emergencySafe,
      handover: {
        timelock,
        ...result.transactions,
        operation: result.operation,
        at: new Date().toISOString(),
      },
    });
    console.log(
      JSON.stringify(
        {
          ...result.transactions,
          operation: result.operation,
          next: "Run safe-batches/handover-1-schedule-accept.json from the governance Safe now and handover-2 after the delay. Until then the owner is still governance; the ProxyAdmin already belongs to the timelock.",
        },
        null,
        2,
      ),
    );
    break;
  }
  case "dev-basescan":
    await submitBasescan(loadRecord(DEV_RECORD), loadDevManifest());
    break;
  default:
    throw new Error(
      "usage: base-mainnet-cli candidate|preflight|deploy-timelock|deploy|verify|batches|basescan|dev-identities|dev-preflight|dev-deploy|dev-configure|dev-upgrade|dev-risk-operator|dev-handover|dev-verify|dev-basescan ...",
    );
}
