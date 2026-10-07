// Shared deployment helpers for the clearing stack, used by the local deploy script and the contract
// end-to-end tests. Artifacts come from `npm run compile:contracts`.
import fs from "node:fs";
import path from "node:path";
import { AbiCoder, Contract, ContractFactory, Interface, encodeBytes32String } from "ethers";
import { linkArtifact } from "../link-artifact.mjs";

export const BASE = 10n ** 18n;

/** The maximum limits: 1M USDC per trade, 5M USDC net, gross and per side, enabled, BTC risk parameters. */
export const MAX_MARKET_CONFIG = {
  symbol: encodeBytes32String("BTC"),
  enabled: true,
  maxTradeNotional: 1_000_000_000_000n,
  maxMarketNotional: 5_000_000_000_000n,
  grossLimit: 5_000_000_000_000n,
  sideLimit: 5_000_000_000_000n,
  impactK: 10_000,
  shockBps: 4_000,
  marginScaleBps: 10_000,
};

/** BTC (id 0) and ETH (id 1) with `limits` applied to both, and the launch risk parameters. */
export function launchMarkets(limits = {}) {
  return [
    { ...MAX_MARKET_CONFIG, ...limits, symbol: encodeBytes32String("BTC"), impactK: 10_000, shockBps: 4_000 },
    { ...MAX_MARKET_CONFIG, ...limits, symbol: encodeBytes32String("ETH"), impactK: 12_000, shockBps: 5_000 },
  ];
}

export const TRADE_INTENT_TYPES = {
  TradeIntent: [
    { name: "account", type: "address" },
    { name: "market", type: "uint8" },
    { name: "baseDelta", type: "int256" },
    { name: "limitPrice", type: "uint256" },
    { name: "maxFee", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint64" },
    { name: "reduceOnly", type: "bool" },
  ],
};

export const MAKER_APPROVAL_TYPES = {
  MakerApproval: [
    { name: "intentHash", type: "bytes32" },
    { name: "executionPrice", type: "uint256" },
    { name: "impactCharge", type: "int256" },
    { name: "fee", type: "uint256" },
    { name: "oracleReportHash", type: "bytes32" },
    { name: "deadline", type: "uint64" },
    { name: "leaderEpoch", type: "uint64" },
    { name: "signerSetVersion", type: "uint64" },
    { name: "policyVersion", type: "uint64" },
  ],
};

export function artifact(name, root = process.cwd()) {
  return JSON.parse(fs.readFileSync(path.join(root, "artifacts", `${name}.json`), "utf8"));
}

/** Library names an artifact links against. */
export function linkedLibraries(item) {
  return [
    ...new Set(Object.values(item.linkReferences ?? {}).flatMap((references) => Object.keys(references))),
  ];
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
  deployer,
  governance,
  usdc,
  oracle,
  emergencyCouncil,
  approvers,
  baseRiskCapitalTarget,
  markets = launchMarkets(),
  unpause = true,
  libraries = {},
}) {
  const implementation = await deployLinked(deployer, "RFQClearing", [], libraries);
  const abi = artifact("RFQClearing").abi;
  const governanceAddress = typeof governance === "string" ? governance : await governance.getAddress();
  const init = new Interface(abi).encodeFunctionData("initialize", [
    usdc,
    oracle,
    governanceAddress,
    emergencyCouncil,
    approvers,
    baseRiskCapitalTarget,
    markets,
  ]);
  const proxy = await deployLinked(deployer, "TestProxy", [
    await implementation.getAddress(),
    governanceAddress,
    init,
  ]);
  const clearing = new Contract(await proxy.getAddress(), abi, deployer);
  if (unpause) {
    if (typeof governance === "string")
      throw new Error("deployClearing needs a governance signer to unpause");
    await (await clearing.connect(governance).unpause()).wait();
  }
  return { clearing, proxy, implementation, libraries };
}

/** ABI-encodes a MockPriceOracle report: one observation, or several in ascending market order. */
export function encodeObservation(observations) {
  const list = Array.isArray(observations) ? observations : [observations];
  return AbiCoder.defaultAbiCoder().encode(
    ["tuple(uint8 market,uint256 bid,uint256 ask,uint64 observedAt,uint64 validUntil)[]"],
    [
      list.map(({ market, bid, ask = bid, observedAt, validUntil }) => [
        market,
        bid,
        ask,
        observedAt,
        validUntil,
      ]),
    ],
  );
}

export const PRICE_BATCH_TYPES = {
  PriceBatch: [
    { name: "observedAt", type: "uint64" },
    { name: "prices", type: "Price[]" },
  ],
  Price: [
    { name: "market", type: "uint8" },
    { name: "bid", type: "uint256" },
    { name: "ask", type: "uint256" },
  ],
};

/**
 * Deploys a SignedPriceOracle owned by `owner` with `nodes` (wallets or addresses) as signers: majority
 * threshold, 1% deviation, 5 s skew and the jump guard off unless overridden.
 */
export async function deploySignedOracle(
  deployer,
  owner,
  nodes,
  {
    threshold = Math.floor(nodes.length / 2) + 1,
    maxDeviationBps = 100,
    maxSkew = 5,
    maxJumpBps = 0,
    jumpWindow = 0,
    libraries = {},
  } = {},
) {
  const signers = await Promise.all(
    nodes.map((node) => (typeof node === "string" ? node : node.getAddress())),
  );
  return deployLinked(
    deployer,
    "SignedPriceOracle",
    [
      typeof owner === "string" ? owner : await owner.getAddress(),
      signers,
      threshold,
      maxDeviationBps,
      maxSkew,
      maxJumpBps,
      jumpWindow,
    ],
    libraries,
  );
}

/**
 * A SignedPriceOracle report: every node signs the same `prices` (ascending `{market, bid, ask}`) at
 * `observedAt`, as the oracle nodes do when their exchange medians agree.
 */
export async function signedOracleReport({ adapter, chainId, nodes, observedAt, prices }) {
  const domain = {
    name: "RFQ Markets Oracle",
    version: "1",
    chainId,
    verifyingContract: await adapter.getAddress(),
  };
  const list = (Array.isArray(prices) ? prices : [prices]).map(({ market, bid, ask = bid }) => ({
    market,
    bid,
    ask,
  }));
  const batches = await Promise.all(
    nodes.map(async (node) => [
      observedAt,
      list.map(({ market, bid, ask }) => [market, bid, ask]),
      await node.signTypedData(domain, PRICE_BATCH_TYPES, { observedAt, prices: list }),
    ]),
  );
  return AbiCoder.defaultAbiCoder().encode(
    ["tuple(uint64 observedAt,tuple(uint8 market,uint256 bid,uint256 ask)[] prices,bytes signature)[]"],
    [batches],
  );
}
