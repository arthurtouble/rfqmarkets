import {
  Contract,
  Interface,
  Wallet,
  decodeBytes32String,
  getAddress,
  type Provider,
  type Signer,
} from "ethers";
import {
  BASE_MAINNET_CHAIN_ID,
  IMPLEMENTATION_SLOT,
  PROXY_ADMIN_ABI,
  artifact,
  checkExternalDependencies,
  checkTimelock,
  estimateDeployCost,
  factory,
  libraryOrder,
  manifestMarkets,
  marketConfigs,
  same,
  timelockOperation,
  verifyCore,
  word,
  type DeploymentRecord,
} from "./base-mainnet.js";
import { DEV_CEILINGS, validateDevManifest } from "./mainnet-manifest.js";

// Development profile for Base mainnet: the owner EOA is both clearing governance and ProxyAdmin
// owner, so caps and upgrades apply immediately. Caps are bounded by DEV_CEILINGS. When the product
// is ready, `handoverDev` moves governance and the ProxyAdmin to a Safe-controlled timelock in place.
export type DevManifest = ReturnType<typeof validateDevManifest>;

/** Markets the dev profile lists after BTC and ETH, in index order. */
export const DEV_LISTINGS = ["SOL", "XRP", "DOGE", "HYPE", "SUI"] as const;

/**
 * Fresh owner, emergency and approver keys plus a dev manifest that uses their addresses. The oracle signers
 * are the oracle nodes' addresses (3..16, majority threshold); their keys stay with the nodes, not here.
 */
export function generateDevIdentities(
  oracleSigners: string[] = [
    "REPLACE_WITH_ORACLE_SIGNER_1",
    "REPLACE_WITH_ORACLE_SIGNER_2",
    "REPLACE_WITH_ORACLE_SIGNER_3",
  ],
) {
  const make = () => {
    const wallet = Wallet.createRandom();
    return { address: wallet.address, privateKey: wallet.privateKey };
  };
  const identities = {
    owner: make(),
    emergency: make(),
    approvers: [make(), make(), make()] as const,
    createdAt: new Date().toISOString(),
  };
  const market = {
    maxTradeUsdc: "25000000",
    netUsdc: "100000000",
    grossUsdc: "200000000",
    sideUsdc: "150000000",
    marginScaleBps: 2_500,
  };
  const listing = {
    maxTradeUsdc: "25000000",
    netUsdc: "50000000",
    grossUsdc: "100000000",
    sideUsdc: "75000000",
  };
  const manifest = {
    version: 1,
    mode: "dev",
    chainId: "8453",
    usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    oracleSigners: [...oracleSigners],
    oracleThreshold: Math.floor(oracleSigners.length / 2) + 1,
    owner: identities.owner.address,
    emergencyCouncil: identities.emergency.address,
    approvers: identities.approvers.map((item) => item.address),
    policy: {
      makerCapitalUsdc: "100000000",
      markets: {
        BTC: market,
        ETH: market,
        // Later listings, in index order (2, 3, ...): every one has a Hyperliquid perp to hedge on and at
        // least three oracle venues. They use LISTING_RISK's defaults and half the launch caps.
        ...Object.fromEntries(DEV_LISTINGS.map((symbol) => [symbol, listing])),
      },
    },
  };
  return { identities, manifest };
}

/** Read-only checks; the deployer must be the owner so deploy, configure and upgrade run from one key. */
export async function devPreflight(
  provider: Provider,
  manifest: DevManifest,
  deployer: string,
  expectedChainId = BASE_MAINNET_CHAIN_ID,
) {
  const network = await provider.getNetwork();
  if (network.chainId !== expectedChainId)
    throw new Error(`expected chain ${expectedChainId}, RPC reports ${network.chainId}`);
  if (!same(deployer, manifest.owner))
    throw new Error(
      "dev profile deploys from the owner key; RFQ_MAINNET_DEPLOYER_KEY must belong to manifest.owner",
    );
  await checkExternalDependencies(provider, manifest);
  return {
    ready: true,
    profile: "dev",
    chainId: network.chainId.toString(),
    ...(await estimateDeployCost(provider, manifest, deployer)),
  };
}

const confirmed = async (tx: Promise<any>, confirmations: number) => {
  const receipt = await (await tx).wait(confirmations);
  if (!receipt || receipt.status !== 1) throw new Error("transaction failed");
  return receipt.hash as string;
};

/**
 * Brings the clearing in line with the manifest: lists the markets it does not have yet (in manifest order,
 * enabled, with their caps), re-applies caps and risk parameters to the markets it has, and sets each
 * market's base spread where the manifest names one. setExposurePolicy needs a paused clearing, so this
 * pauses first and unpauses at the end when the clearing was running before or `unpause` is set: a
 * configure run never leaves a live venue paused.
 */
export async function configureDev(
  owner: Signer,
  record: DeploymentRecord,
  manifest: DevManifest,
  options: { unpause?: boolean; confirmations?: number } = {},
) {
  const clearing = new Contract(record.contracts.clearingProxy, artifact("RFQClearing").abi, owner),
    confirmations = options.confirmations ?? 2,
    transactions: string[] = [],
    send = async (tx: Promise<any>) => void transactions.push(await confirmed(tx, confirmations));
  const symbols = manifestMarkets(manifest),
    listed = Number(await clearing.marketCount());
  if (listed > symbols.length)
    throw new Error(`the clearing lists ${listed} markets but the manifest names only ${symbols.length}`);
  // Indexes are permanent: the manifest must name the listed markets in their on-chain order.
  for (let market = 0; market < listed; market++) {
    const symbol = decodeBytes32String((await clearing.marketParams(market)).symbol);
    if (symbol !== symbols[market])
      throw new Error(`market ${market} is ${symbol} on chain but ${symbols[market]} in the manifest`);
  }
  const wasPaused = (await clearing.paused()) as boolean;
  if (!wasPaused) await send(clearing.pause());
  for (let market = 0; market < listed; market++) {
    const item = manifest.policy.markets[symbols[market]];
    await send(clearing.setExposurePolicy(market, item.grossUsdc, item.sideUsdc));
    await send(clearing.setMarketPolicy(market, true, item.maxTradeUsdc, item.netUsdc));
    const params = await clearing.marketParams(market);
    if (
      Number(params.impactK) !== item.impactK ||
      Number(params.shockBps) !== item.shockBps ||
      Number(params.marginScaleBps) !== item.marginScaleBps
    )
      await send(clearing.setMarketRisk(market, item.impactK, item.shockBps, item.marginScaleBps));
  }
  for (const config of marketConfigs(manifest).slice(listed)) await send(clearing.addMarket(config));
  for (const [market, symbol] of symbols.entries()) {
    const spread = manifest.policy.markets[symbol].baseSpreadBps;
    if (spread !== undefined && Number(await clearing.marketSpread(market)) !== spread)
      await send(clearing.setSpread(market, spread));
  }
  if (options.unpause || !wasPaused) await send(clearing.unpause());
  return transactions;
}

/**
 * Appoints the risk operator (v1.2) with the dev ceilings as its envelope, so the operations console can list
 * and tune markets from the operator's wallet without the owner key. Floors are the contract's own.
 */
export async function appointRiskOperatorDev(
  owner: Signer,
  record: DeploymentRecord,
  operator: string,
  confirmations = 2,
) {
  const clearing = new Contract(record.contracts.clearingProxy, artifact("RFQClearing").abi, owner);
  const bounds = {
    maxTradeNotional: DEV_CEILINGS.maxTradeUsdc,
    maxMarketNotional: DEV_CEILINGS.netUsdc,
    maxGrossLimit: DEV_CEILINGS.grossUsdc,
    minImpactK: 1,
    minShockBps: 500,
    minMarginScaleBps: 2_500,
  };
  return [
    await confirmed(clearing.setRiskOperatorBounds(bounds), confirmations),
    await confirmed(clearing.setRiskOperator(getAddress(operator)), confirmations),
  ];
}

/** Unpauses a freshly deployed dev clearing (v1 starts paused). */
export async function unpauseDev(owner: Signer, record: DeploymentRecord, confirmations = 2) {
  return confirmed(
    new Contract(record.contracts.clearingProxy, artifact("RFQClearing").abi, owner).unpause(),
    confirmations,
  );
}

export async function verifyDev(provider: Provider, record: DeploymentRecord, manifest: DevManifest) {
  const { checks, state } = await verifyCore(provider, record, manifest);
  return { verified: true, profile: "dev", checks, state };
}

/** Deploys fresh libraries and implementation from the current build and points the proxy at them in one owner transaction. */
export async function upgradeDev(
  owner: Signer,
  record: DeploymentRecord,
  options: { candidateHash: string; confirmations?: number },
) {
  const provider = owner.provider!,
    confirmations = options.confirmations ?? 2,
    libraries: Record<string, string> = {};
  const proxyAdmin = new Contract(record.contracts.proxyAdmin, PROXY_ADMIN_ABI, owner);
  if (!same(await proxyAdmin.owner(), await owner.getAddress()))
    throw new Error("signer does not own the ProxyAdmin");
  const deploy = async (step: string) => {
    const contract = await factory(step, libraries, owner).deploy();
    const receipt = await contract.deploymentTransaction()!.wait(confirmations);
    if (!receipt || receipt.status !== 1) throw new Error(`${step} deployment failed`);
    return getAddress(receipt.contractAddress!);
  };
  for (const library of libraryOrder()) libraries[library] = await deploy(library);
  const implementation = await deploy("clearingImplementation");
  const transaction = await confirmed(
    proxyAdmin.upgradeAndCall(record.contracts.clearingProxy, implementation, "0x"),
    confirmations,
  );
  if (
    !same(
      word(await provider.getStorage(record.contracts.clearingProxy, IMPLEMENTATION_SLOT)),
      implementation,
    )
  )
    throw new Error("proxy does not point at the new implementation");
  const upgrade = {
    implementation,
    libraries,
    transaction,
    candidateHash: options.candidateHash,
    at: new Date().toISOString(),
  };
  return {
    ...record,
    contracts: { ...record.contracts, libraries, clearingImplementation: implementation },
    upgrades: [...(record.upgrades ?? []), upgrade],
  } satisfies DeploymentRecord;
}

/**
 * Moves a dev deployment to production governance in place. The owner sets the emergency Safe, nominates
 * the timelock as governance and as SignedPriceOracle owner (two-step), and hands it the ProxyAdmin. The
 * governance Safe then accepts both through the timelock (schedule now, execute after the delay). Until
 * acceptance the owner is still governance and oracle owner.
 */
export async function handoverDev(
  owner: Signer,
  record: DeploymentRecord,
  target: {
    timelock: string;
    governanceSafe: string;
    emergencySafe: string;
    minimumDelaySeconds: number;
    confirmations?: number;
  },
) {
  const provider = owner.provider!,
    confirmations = target.confirmations ?? 2,
    ownerAddress = await owner.getAddress();
  const delay = await checkTimelock(
    provider,
    target.timelock,
    target.governanceSafe,
    target.minimumDelaySeconds,
    [ownerAddress],
  );
  for (const [name, address] of [
    ["governance Safe", target.governanceSafe],
    ["emergency Safe", target.emergencySafe],
  ] as const)
    if ((await provider.getCode(address)) === "0x") throw new Error(`${name} ${address} has no code`);
  const clearing = new Contract(record.contracts.clearingProxy, artifact("RFQClearing").abi, owner),
    proxyAdmin = new Contract(record.contracts.proxyAdmin, PROXY_ADMIN_ABI, owner),
    oracle = new Contract(record.contracts.oracleAdapter, artifact("SignedPriceOracle").abi, owner);
  if (
    !same(await clearing.governance(), ownerAddress) ||
    !same(await proxyAdmin.owner(), ownerAddress) ||
    !same(await oracle.owner(), ownerAddress)
  )
    throw new Error("signer is not clearing governance, ProxyAdmin owner and oracle owner");
  const transactions: Record<string, string> = {};
  if (!same(await clearing.emergencyCouncil(), target.emergencySafe))
    transactions.setEmergencyCouncil = await confirmed(
      clearing.setEmergencyCouncil(target.emergencySafe),
      confirmations,
    );
  transactions.transferGovernance = await confirmed(
    clearing.transferGovernance(target.timelock),
    confirmations,
  );
  transactions.transferOracleOwnership = await confirmed(
    oracle.transferOwnership(target.timelock),
    confirmations,
  );
  transactions.transferProxyAdmin = await confirmed(
    proxyAdmin.transferOwnership(target.timelock),
    confirmations,
  );
  const accept = new Interface(artifact("RFQClearing").abi).encodeFunctionData("acceptGovernance"),
    acceptOracle = oracle.interface.encodeFunctionData("acceptOwnership");
  const op = timelockOperation(
    record.chainId,
    target.timelock,
    target.governanceSafe,
    [
      { to: record.contracts.clearingProxy, data: accept },
      { to: record.contracts.oracleAdapter, data: acceptOracle },
    ],
    delay,
    "RFQ governance handover",
    `rfq-markets:${record.contracts.clearingProxy}:accept-governance`,
    {
      schedule: "Schedules acceptGovernance and the oracle's acceptOwnership by the timelock.",
      execute: "Completes the handover after the timelock delay.",
    },
  );
  return {
    transactions,
    operation: { id: op.id, salt: op.salt },
    acceptSchedule: op.schedule,
    acceptExecute: op.execute,
  };
}
