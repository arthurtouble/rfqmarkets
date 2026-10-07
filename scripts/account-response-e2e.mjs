import { validateRuntimeIdentity } from "./runtime-identity.ts";
import { buildApprover } from "../services/approver/src/server.ts";
import assert from "node:assert/strict";
import fs from "node:fs";
import { network } from "hardhat";
import { JsonRpcProvider } from "ethers";
import { buildApi } from "../services/api/src/server.ts";
import { approvalTypes } from "../packages/shared/src/eip712.ts";
import {
  deployLinked,
  deploySignedOracle,
  launchMarkets,
  signedOracleReport,
} from "./lib/contract-fixture.mjs";
const { ethers } = await network.create({ network: "hardhatOp", chainType: "op" }),
  [governance, emergency, a, b, c, maker, user] = await ethers.getSigners(),
  libraries = {};
const artifact = (name) => JSON.parse(fs.readFileSync(`artifacts/${name}.json`, "utf8")),
  deploy = (name, args = []) => deployLinked(governance, name, args, libraries);
const risk = await deploy("RFQRiskMath"),
  signatures = await deploy("RFQSignatureVerifier");
libraries.RFQRiskMath = await risk.getAddress();
libraries.RFQSignatureVerifier = await signatures.getAddress();
const token = await deploy("MockUSDC"),
  implementation = await deploy("RFQClearing"),
  oracleNodes = [0, 1, 2].map(() => ethers.Wallet.createRandom()),
  adapter = await deploySignedOracle(governance, governance, oracleNodes, { libraries });
const init = new ethers.Interface(artifact("RFQClearing").abi).encodeFunctionData("initialize", [
    await token.getAddress(),
    await adapter.getAddress(),
    governance.address,
    emergency.address,
    [a.address, b.address, c.address],
    600_000_000_000n,
    launchMarkets().map((market, index) => ({ ...market, marginScaleBps: index === 0 ? 2_500 : 10_000 })),
  ]),
  proxy = await deploy("TestProxy", [await implementation.getAddress(), governance.address, init]),
  clearing = new ethers.Contract(await proxy.getAddress(), artifact("RFQClearing").abi, governance);
await (await clearing.unpause()).wait();
await (await adapter.setClearing(await proxy.getAddress())).wait();
await (await token.mint(maker.address, 1_000_000_000_000n)).wait();
await (await token.connect(maker).approve(await proxy.getAddress(), ethers.MaxUint256)).wait();
await (await clearing.connect(maker).fundMaker(800_000_000_000n)).wait();
await (await clearing.connect(maker).fundInsurance(200_000_000_000n)).wait();
await (await token.mint(user.address, 4_000_000_000n)).wait();
await (await token.connect(user).approve(await proxy.getAddress(), ethers.MaxUint256)).wait();
await (await clearing.connect(user).deposit(4_000_000_000n)).wait();
const prices = [100_000_000_000n, 4_000_000_000n];
async function oracle(market) {
  const index = market === "BTC" ? 0 : 1,
    block = await ethers.provider.getBlock("latest");
  return {
    snapshot: { market, bid: prices[index], ask: prices[index], observedAtMs: Date.now(), source: "signed" },
    report: await signedOracleReport({
      adapter,
      chainId: (await ethers.provider.getNetwork()).chainId,
      nodes: oracleNodes,
      observedAt: block.timestamp,
      prices: { market: index, bid: prices[index] },
    }),
    validUntil: block.timestamp + 15,
  };
}
for (const market of ["BTC", "ETH"]) {
  const observation = await oracle(market);
  await (await clearing.refreshOracle(observation.report)).wait();
}
class Chain extends JsonRpcProvider {
  async send(method, params) {
    return ethers.provider.send(method, params);
  }
  async getNetwork() {
    return ethers.provider.getNetwork();
  }
  async getBlockNumber() {
    return ethers.provider.getBlockNumber();
  }
  async getBlock(tag) {
    return ethers.provider.getBlock(tag);
  }
  async call(request) {
    return ethers.provider.call(request);
  }
}
const provider = new Chain(),
  sponsor = ethers.Wallet.createRandom();
await (await governance.sendTransaction({ to: sponsor.address, value: ethers.parseEther("1") })).wait();
const domainChainId = (await ethers.provider.getNetwork()).chainId,
  proxyAddress = await proxy.getAddress();
const approverApps = [a, b, c].map((signer, index) => {
  const key = ethers.HDNodeWallet.fromPhrase(
    "test test test test test test test test test test test junk",
    undefined,
    `m/44'/60'/0'/0/${index + 2}`,
  );
  assert.equal(key.address, signer.address);
  return buildApprover({
    provider,
    privateKey: key.privateKey,
    transportToken: "private",
    databasePath: ":memory:",
    expectedChainId: domainChainId,
    expectedVerifyingContract: proxyAddress,
    oracleMode: "signed",
  });
});
let approvals = 0;
const app = buildApi({
  provider,
  chainId: (await ethers.provider.getNetwork()).chainId,
  verifyingContract: await proxy.getAddress(),
  chain: {
    rpcUrl: "http://127.0.0.1:8545",
    sponsorPrivateKey: sponsor.privateKey,
    clearingAddress: await proxy.getAddress(),
    tokenAddress: await token.getAddress(),
  },
  oracleSource: { latest: oracle },
  approvers: [a, b, c].map((signer, index) => ({ url: `http://approver-${index}`, token: "private" })),
  fetchImpl: async (url, request) => {
    const index = Number(String(url).match(/approver-(\d)/)[1]),
      payload = JSON.parse(request.body);
    approvals++;
    const response = await approverApps[index].inject({
      method: "POST",
      url: "/approve",
      headers: { authorization: "Bearer private" },
      payload,
    });
    return new Response(response.body, { status: response.statusCode });
  },
  sender: {
    reconcile: async () => {},
    status: () => [],
    submit: async (_id, request) => {
      const tx = await governance.sendTransaction(request),
        receipt = await tx.wait();
      return {
        hash: receipt.hash,
        blockNumber: receipt.blockNumber,
        blockHash: receipt.blockHash,
        status: 1,
      };
    },
  },
});
async function post(url, payload) {
  const response = await app.inject({ method: "POST", url, payload });
  assert.equal(response.statusCode, 200, response.body);
  return response.json();
}

try {
  const identity = {
    chainId: domainChainId,
    clearingAddress: proxyAddress,
    tokenAddress: await token.getAddress(),
    oracleAddress: await adapter.getAddress(),
    oracleSigners: oracleNodes.map((node) => node.address),
    oracleThreshold: 2,
    governance: governance.address,
    emergencyCouncil: emergency.address,
    approvers: [a.address, b.address, c.address],
    implementationAddress: await implementation.getAddress(),
    riskMathAddress: await risk.getAddress(),
    signatureVerifierAddress: await signatures.getAddress(),
    code: [],
  };
  for (const contract of [proxy, token, adapter, implementation, risk, signatures]) {
    const address = await contract.getAddress();
    identity.code.push({ address, hash: ethers.keccak256(await ethers.provider.getCode(address)) });
  }
  const independent = new Chain();
  await validateRuntimeIdentity(provider, independent, identity);
  await assert.rejects(
    validateRuntimeIdentity(provider, independent, {
      ...identity,
      oracleSigners: [ethers.Wallet.createRandom().address, ...identity.oracleSigners.slice(1)],
    }),
    /oracle signer mismatch/,
  );
  await assert.rejects(
    validateRuntimeIdentity(provider, independent, {
      ...identity,
      code: identity.code.map((item, i) => (i === 4 ? { ...item, hash: ethers.ZeroHash } : item)),
    }),
    /bytecode identity/,
  );
  await assert.rejects(
    validateRuntimeIdentity(provider, independent, {
      ...identity,
      implementationAddress: await risk.getAddress(),
    }),
    /identity mismatch/,
  );
  await assert.rejects(
    validateRuntimeIdentity(provider, independent, {
      ...identity,
      approvers: [a.address, b.address, user.address],
    }),
    /approver identity/,
  );
  const divergent = new Chain();
  divergent.getBlock = async () => ({ hash: ethers.ZeroHash });
  await assert.rejects(validateRuntimeIdentity(provider, divergent, identity), /block identity/);
  divergent.destroy();
  independent.destroy();
  await app.ready();
  for (const [market, nonce] of [
    ["BTC", "810"],
    ["ETH", "811"],
  ]) {
    const quote = await post("/v1/quote", { market, side: "buy", amount: "100" }),
      prepared = await post("/v1/prepare", { quoteId: quote.quoteId, account: user.address, nonce }),
      signature = await user.signTypedData(prepared.domain, prepared.types, prepared.intent);
    await post("/v1/approve", {
      quoteId: quote.quoteId,
      account: user.address,
      nonce,
      userSignature: signature,
    });
  }
  prices[0] = 200_000_000_000n;
  prices[1] = 2_000_000_000n;
  for (const market of ["BTC", "ETH"]) {
    const observation = await oracle(market);
    await (await clearing.refreshOracle(observation.report)).wait();
  }
  await new Promise((resolve) => setTimeout(resolve, 250));
  const response = await app.inject(`/v1/account/${user.address}`);
  assert.equal(response.statusCode, 200, response.body);
  const account = response.json();
  assert(BigInt(account.positions.BTC.unrealizedPnl) > 0n);
  assert(BigInt(account.positions.ETH.unrealizedPnl) < 0n);
  assert.equal(
    BigInt(account.openingEquity),
    BigInt(account.collateral) + BigInt(account.accruedFunding) + BigInt(account.positions.ETH.unrealizedPnl),
  );
  assert.equal(account.openingEquity, account.onchain.openingEquity);
  assert.equal(account.equity, account.onchain.maintenanceEquity);
  assert.equal(account.initialMargin, account.onchain.initialMargin);
  assert.equal(account.maintenanceMargin, account.onchain.maintenanceMargin);
  assert.equal(account.marginParameters.BTC.maxLeverage, 20);
  assert.equal(account.marginParameters.ETH.maxLeverage, 5);
  console.log(
    "Runtime identity and account response E2E passed: dual RPC/code/feed/authority rejection, mixed winner/loser opening margin and separate-leg rounding match canonical clearing at a pinned block",
  );
} finally {
  await app.close();
  for (const approver of approverApps) await approver.close();
}
