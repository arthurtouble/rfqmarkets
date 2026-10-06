// Shared deployment helpers for the clearing stack, used by the local deploy script and the contract
// end-to-end tests. Artifacts come from `npm run compile:contracts`.
import fs from "node:fs";
import path from "node:path";
import { AbiCoder, Contract, ContractFactory, Interface } from "ethers";
import { linkArtifact } from "../link-artifact.mjs";

export const BASE = 10n ** 18n;

/** The pre-v1 maximum limits: 1M USDC per trade, 5M USDC net, gross and per side, both markets enabled. */
export const MAX_MARKET_CONFIG = {
  enabled: true,
  maxTradeNotional: 1_000_000_000_000n,
  maxMarketNotional: 5_000_000_000_000n,
  grossLimit: 5_000_000_000_000n,
  sideLimit: 5_000_000_000_000n,
};

export const TRADE_INTENT_TYPES = { TradeIntent: [
  { name: "account", type: "address" }, { name: "market", type: "uint8" }, { name: "baseDelta", type: "int256" },
  { name: "limitPrice", type: "uint256" }, { name: "maxFee", type: "uint256" }, { name: "nonce", type: "uint256" },
  { name: "deadline", type: "uint64" }, { name: "reduceOnly", type: "bool" },
] };

export const MAKER_APPROVAL_TYPES = { MakerApproval: [
  { name: "intentHash", type: "bytes32" }, { name: "executionPrice", type: "uint256" },
  { name: "impactCharge", type: "int256" }, { name: "fee", type: "uint256" }, { name: "oracleReportHash", type: "bytes32" },
  { name: "deadline", type: "uint64" }, { name: "leaderEpoch", type: "uint64" },
  { name: "signerSetVersion", type: "uint64" }, { name: "policyVersion", type: "uint64" },
] };

export function artifact(name, root = process.cwd()) {
  return JSON.parse(fs.readFileSync(path.join(root, "artifacts", `${name}.json`), "utf8"));
}

/** Library names an artifact links against. */
export function linkedLibraries(item) {
  return [...new Set(Object.values(item.linkReferences ?? {}).flatMap((references) => Object.keys(references)))];
}

/**
 * Deploys `name`, first deploying (once, into `libraries`) every library it links, recursively.
 * `libraries` maps library name to address and is shared across calls so each library deploys once.
 */
export async function deployLinked(signer, name, args = [], libraries = {}) {
  const item = artifact(name);
  for (const library of linkedLibraries(item)) {
    if (!libraries[library]) {
      const deployed = await deployLinked(signer, library, [], libraries);
      libraries[library] = await deployed.getAddress();
    }
  }
  const linked = linkArtifact(item, libraries);
  const contract = await new ContractFactory(linked.abi, linked.bytecode, signer).deploy(...args);
  await contract.waitForDeployment();
  return contract;
}

/**
 * Deploys the clearing implementation behind a TestProxy (whose ProxyAdmin is owned by `governance`) and
 * initializes it. The proxy starts paused; with `unpause` (the default) governance unpauses it.
 */
export async function deployClearing({
  deployer, governance, usdc, oracle, emergencyCouncil, approvers, baseRiskCapitalTarget,
  markets = [MAX_MARKET_CONFIG, MAX_MARKET_CONFIG], unpause = true, libraries = {},
}) {
  const implementation = await deployLinked(deployer, "RFQClearing", [], libraries);
  const abi = artifact("RFQClearing").abi;
  const governanceAddress = typeof governance === "string" ? governance : await governance.getAddress();
  const init = new Interface(abi).encodeFunctionData("initialize", [
    usdc, oracle, governanceAddress, emergencyCouncil, approvers, baseRiskCapitalTarget, markets,
  ]);
  const proxy = await deployLinked(deployer, "TestProxy", [await implementation.getAddress(), governanceAddress, init]);
  const clearing = new Contract(await proxy.getAddress(), abi, deployer);
  if (unpause) {
    if (typeof governance === "string") throw new Error("deployClearing needs a governance signer to unpause");
    await (await clearing.connect(governance).unpause()).wait();
  }
  return { clearing, proxy, implementation, libraries };
}

/** ABI-encodes a MockPriceOracle observation. */
export function encodeObservation({ market, bid, ask = bid, observedAt, validUntil }) {
  return AbiCoder.defaultAbiCoder().encode(
    ["tuple(uint8 market,uint256 bid,uint256 ask,uint64 observedAt,uint64 validUntil)"],
    [[market, bid, ask, observedAt, validUntil]],
  );
}
