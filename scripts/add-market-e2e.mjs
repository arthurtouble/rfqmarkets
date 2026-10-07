// Governance adds a third market (SOL) to a running local deployment; the API and approvers pick it up
// from the clearing registry without a code change or restart, and a user trades it through the API.
import assert from "node:assert/strict";
import fs from "node:fs";
import { network } from "hardhat";
import { JsonRpcProvider, encodeBytes32String } from "ethers";
import { buildApi } from "../services/api/src/server.ts";
import { buildApprover } from "../services/approver/src/server.ts";
import { marketRegistry } from "../packages/shared/src/markets.ts";
import {
  MAX_MARKET_CONFIG,
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
libraries.RFQRiskMath = await (await deploy("RFQRiskMath")).getAddress();
libraries.RFQSignatureVerifier = await (await deploy("RFQSignatureVerifier")).getAddress();
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
    launchMarkets(),
  ]),
  proxy = await deploy("TestProxy", [await implementation.getAddress(), governance.address, init]),
  proxyAddress = await proxy.getAddress(),
  clearing = new ethers.Contract(proxyAddress, artifact("RFQClearing").abi, governance);
await (await clearing.unpause()).wait();
await (await adapter.setClearing(proxyAddress)).wait();
await (await token.mint(maker.address, 1_000_000_000_000n)).wait();
await (await token.connect(maker).approve(proxyAddress, ethers.MaxUint256)).wait();
await (await clearing.connect(maker).fundMaker(800_000_000_000n)).wait();
await (await clearing.connect(maker).fundInsurance(200_000_000_000n)).wait();
await (await token.mint(user.address, 4_000_000_000n)).wait();
await (await token.connect(user).approve(proxyAddress, ethers.MaxUint256)).wait();
await (await clearing.connect(user).deposit(4_000_000_000n)).wait();

// Prices by symbol; the oracle stub signs a report for whatever index the registry gives the symbol.
const prices = { BTC: 100_000_000_000n, ETH: 4_000_000_000n, SOL: 150_000_000n },
  chainId = (await ethers.provider.getNetwork()).chainId;
async function oracle(market) {
  if (!marketRegistry.has(market)) throw new Error(`no price for ${market}`);
  const index = marketRegistry.index(market),
    block = await ethers.provider.getBlock("latest");
  return {
    snapshot: { market, bid: prices[market], ask: prices[market], observedAtMs: Date.now(), source: "signed" },
    report: await signedOracleReport({
      adapter,
      chainId,
      nodes: oracleNodes,
      observedAt: block.timestamp,
      prices: { market: index, bid: prices[market] },
    }),
    validUntil: block.timestamp + 15,
  };
}
for (const market of ["BTC", "ETH"]) await (await clearing.refreshOracle((await oracle(market)).report)).wait();

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
    expectedChainId: chainId,
    expectedVerifyingContract: proxyAddress,
    oracleMode: "signed",
  });
});
const app = buildApi({
  provider,
  chainId,
  verifyingContract: proxyAddress,
  marketRefreshMs: 1_000,
  chain: {
    rpcUrl: "http://127.0.0.1:8545",
    sponsorPrivateKey: sponsor.privateKey,
    clearingAddress: proxyAddress,
    tokenAddress: await token.getAddress(),
  },
  oracleSource: { latest: oracle },
  approvers: [0, 1, 2].map((index) => ({ url: `http://approver-${index}`, token: "private" })),
  fetchImpl: async (url, request) => {
    const index = Number(String(url).match(/approver-(\d)/)[1]),
      response = await approverApps[index].inject({
        method: "POST",
        url: "/approve",
        headers: { authorization: "Bearer private" },
        payload: JSON.parse(request.body),
      });
    return new Response(response.body, { status: response.statusCode });
  },
  sender: {
    reconcile: async () => {},
    status: () => [],
    submit: async (_id, request) => {
      const receipt = await (await governance.sendTransaction(request)).wait();
      return { hash: receipt.hash, blockNumber: receipt.blockNumber, blockHash: receipt.blockHash, status: 1 };
    },
  },
});
async function post(url, payload, status = 200) {
  const response = await app.inject({ method: "POST", url, payload });
  assert.equal(response.statusCode, status, `${url}: ${response.body}`);
  return response.json();
}
async function trade(market, side, amount, nonce) {
  const quote = await post("/v1/quote", { market, side, amount }),
    prepared = await post("/v1/prepare", { quoteId: quote.quoteId, account: user.address, nonce }),
    userSignature = await user.signTypedData(prepared.domain, prepared.types, prepared.intent);
  assert.equal(prepared.intent.market, marketRegistry.index(market));
  return post("/v1/approve", { quoteId: quote.quoteId, account: user.address, nonce, userSignature });
}

try {
  await app.ready();
  for (const approver of approverApps) await approver.ready();
  assert.deepEqual(marketRegistry.symbols(), ["BTC", "ETH"]);
  await post("/v1/quote", { market: "SOL", side: "buy", amount: "100" }, 400);

  // Governance lists SOL: a different risk profile, 0.5x margin scale and tighter caps.
  const listing = {
    ...MAX_MARKET_CONFIG,
    symbol: encodeBytes32String("SOL"),
    maxTradeNotional: 50_000_000_000n,
    maxMarketNotional: 500_000_000_000n,
    grossLimit: 500_000_000_000n,
    sideLimit: 500_000_000_000n,
    impactK: 15_000,
    shockBps: 6_000,
    marginScaleBps: 20_000,
  };
  await (await clearing.addMarket(listing)).wait();
  assert.equal(Number(await clearing.marketCount()), 3);

  // The API learns SOL from the clearing registry within its refresh interval (no restart).
  const deadline = Date.now() + 15_000;
  while (!marketRegistry.has("SOL")) {
    assert(Date.now() < deadline, "the API never loaded SOL from the registry");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const sol = marketRegistry.get("SOL");
  assert.equal(sol.index, 2);
  assert.equal(sol.shockBps, 6_000n);
  assert.equal(sol.marginScaleBps, 20_000);
  assert.equal(marketRegistry.mask, 7n);
  await (await clearing.refreshOracle((await oracle("SOL")).report)).wait();

  const config = (await app.inject("/v1/config")).json();
  assert.deepEqual(
    config.marketList.map((market) => market.symbol),
    ["BTC", "ETH", "SOL"],
  );
  const markets = (await app.inject("/v1/markets")).json();
  assert.equal(markets.markets.SOL.index, 2);
  assert.equal(markets.markets.SOL.mid, prices.SOL.toString());

  // Open and add to a SOL position, then a BTC leg so cross-market margin and stress include SOL.
  await trade("SOL", "buy", "300", "910");
  await trade("BTC", "buy", "100", "911");
  const [size] = await clearing.positionOf(user.address, 2);
  assert(size > 0n, "the SOL fill settled on chain");
  assert.equal((await clearing.openMarketsOf(user.address)) & 7n, 5n);

  const account = (await app.inject(`/v1/account/${user.address}`)).json();
  assert.equal(account.positions.SOL.size, size.toString());
  assert.equal(account.initialMargin, account.onchain.initialMargin);
  assert.equal(account.maintenanceMargin, account.onchain.maintenanceMargin);

  // Reducing works the same way; a SOL quote above its own trade cap is refused.
  await trade("SOL", "sell", "100", "912");
  const [reduced] = await clearing.positionOf(user.address, 2);
  assert(reduced > 0n && reduced < size);
  await post("/v1/quote", { market: "SOL", side: "buy", amount: "60000" }, 503);
  console.log(
    "Add-market E2E passed: governance addMarket(SOL) reached the API and approvers through the clearing registry; SOL opened, reduced and margined with BTC at the chain's figures",
  );
} finally {
  await app.close();
  for (const approver of approverApps) await approver.close();
}
