import assert from "node:assert/strict";
import fs from "node:fs";
import { network } from "hardhat";
import { deployLinked, launchMarkets } from "./lib/contract-fixture.mjs";
const { ethers } = await network.create({ network: "hardhatOp", chainType: "op" });
const [gov, emergency, a, b, c, maker, long, short, third] = await ethers.getSigners(),
  libraries = {};
const artifact = (name) => JSON.parse(fs.readFileSync(`artifacts/${name}.json`, "utf8"));
const deploy = (name, args = []) => deployLinked(gov, name, args, libraries);
const token = await deploy("MockUSDC"),
  oracle = await deploy("MockPriceOracle"),
  risk = await deploy("RFQRiskMath");
libraries.RFQRiskMath = await risk.getAddress();
const signatures = await deploy("RFQSignatureVerifier");
libraries.RFQSignatureVerifier = await signatures.getAddress();
const implementation = await deploy("RFQClearing"),
  init = new ethers.Interface(artifact("RFQClearing").abi).encodeFunctionData("initialize", [
    await token.getAddress(),
    await oracle.getAddress(),
    gov.address,
    emergency.address,
    [a.address, b.address, c.address],
    100_000_000_000n,
    launchMarkets(),
  ]);
const proxy = await deploy("TestProxy", [await implementation.getAddress(), gov.address, init]),
  clearing = new ethers.Contract(await proxy.getAddress(), artifact("RFQClearing").abi, gov);
await (await clearing.unpause()).wait();
await (await token.mint(maker.address, 200_000_000_000n)).wait();
await (await token.connect(maker).approve(await proxy.getAddress(), ethers.MaxUint256)).wait();
await (await clearing.connect(maker).fundMaker(99_999_000_000n)).wait();
for (const user of [long, short, third]) {
  await (await token.mint(user.address, 100_000_000_000n)).wait();
  await (await token.connect(user).approve(await proxy.getAddress(), ethers.MaxUint256)).wait();
  await (await clearing.connect(user).deposit(100_000_000_000n)).wait();
}
const IMPACT_K = [10_000, 12_000],
  prices = [100_000_000_000n, 4_000_000_000n],
  BASE = 10n ** 18n;
const report = async (market) => {
  const block = await ethers.provider.getBlock("latest");
  return ethers.AbiCoder.defaultAbiCoder().encode(
    ["tuple(uint8 market,uint256 bid,uint256 ask,uint64 observedAt,uint64 validUntil)[]"],
    [[[market, prices[market], prices[market], block.timestamp, block.timestamp + 60]]],
  );
};
const refresh = async () => {
  for (let i = 0; i < 2; i++) await (await clearing.refreshOracle(await report(i))).wait();
};
const domain = {
  name: "RFQ Markets",
  version: "1",
  chainId: (await ethers.provider.getNetwork()).chainId,
  verifyingContract: await proxy.getAddress(),
};
const types = {
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
  },
  approvalTypes = {
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
let nonce = 0n;
const trade = async (user, delta, market = 0, reduceOnly = false) => {
  const proof = await report(market),
    btc = await clearing.markets(0),
    eth = await clearing.markets(1),
    impact = await risk.impactCost(
      IMPACT_K[market],
      ([btc, eth][market].aggregateBase * prices[market]) / BASE,
      (delta * prices[market]) / BASE,
    ),
    charge = impact > 0n ? impact : 0n,
    premium = (charge * BASE + (delta < 0n ? -delta : delta) - 1n) / (delta < 0n ? -delta : delta),
    price = prices[market] + (delta > 0n ? premium : -premium);
  const block = await ethers.provider.getBlock("latest"),
    intent = {
      account: user.address,
      market,
      baseDelta: delta,
      limitPrice: price,
      maxFee: 0n,
      nonce: ++nonce,
      deadline: BigInt(block.timestamp + 60),
      reduceOnly,
    },
    approval = {
      intentHash: ethers.TypedDataEncoder.hash(domain, types, intent),
      executionPrice: price,
      impactCharge: charge,
      fee: 0n,
      oracleReportHash: ethers.keccak256(proof),
      deadline: intent.deadline,
      leaderEpoch: await clearing.leaderEpoch(),
      signerSetVersion: await clearing.signerSetVersion(),
      policyVersion: await clearing.policyVersion(),
    };
  return (
    await clearing.executeTrade(
      intent,
      approval,
      proof,
      await user.signTypedData(domain, types, intent),
      await a.signTypedData(domain, approvalTypes, approval),
      await b.signTypedData(domain, approvalTypes, approval),
    )
  ).wait();
};
const configure = async (gross, side) => {
  await (await clearing.pause()).wait();
  await (await clearing.setExposurePolicy(0, gross, side)).wait();
  await (await clearing.unpause()).wait();
};
await refresh();
await assert.rejects(
  clearing.connect(third).declareResolution(),
  "an empty underfunded deployment must not be griefable",
);
await assert.rejects(trade(long, BASE / 10n), "opening below maker capital floor must fail");
await (await clearing.connect(maker).fundMaker(1_000_000n)).wait();
await configure(25_000_000_000n, 20_000_000_000n);
await refresh();
await trade(long, BASE / 10n);
await trade(short, -BASE / 10n);
assert.equal((await clearing.markets(0)).aggregateBase, 0n);
let book = await clearing.exposureState(0);
assert.equal(book.longBase, BASE / 10n);
assert.equal(book.shortBase, BASE / 10n);
await assert.rejects(trade(short, -BASE / 10n), "opposing positions must not bypass gross cap");
assert.equal((await clearing.exposureState(0)).shortBase, BASE / 10n);
await configure(50_000_000_000n, 15_000_000_000n);
await refresh();
await assert.rejects(trade(third, (6n * BASE) / 100n), "side cap must bind independently of gross cap");
const opposing = await ethers.provider.send("evm_snapshot", []);
await ethers.provider.send("evm_increaseTime", [20]);
await ethers.provider.send("evm_mine", []);
await assert.rejects(trade(third, BASE, 1), "zero net exposure must not hide stale gross positions");
await ethers.provider.send("evm_revert", [opposing]);
const branch = await ethers.provider.send("evm_snapshot", []);
await configure(10_000_000_000n, 5_000_000_000n);
await refresh();
await trade(long, -BASE / 20n, 0, true);
book = await clearing.exposureState(0);
assert.equal(book.longBase, BASE / 20n);
assert.equal(book.shortBase, BASE / 10n);
await assert.rejects(trade(long, BASE / 100n), "opening above tightened cap must fail");
await ethers.provider.send("evm_revert", [branch]);
await refresh();
await trade(short, BASE / 10n, 0, true);
await (await clearing.setMarketPolicy(0, false, 100_000_000n, 1_000_000_000n)).wait();
await refresh();
await trade(long, -BASE / 20n, 0, true);
assert.equal(
  (await clearing.exposureState(0)).longBase,
  BASE / 20n,
  "reduction above tightened net/trade caps must remain available",
);
await assert.rejects(trade(third, BASE / 1000n), "disabled market must reject new exposure");
await trade(long, -BASE / 20n, 0, true);
assert.equal((await clearing.exposureState(0)).longBase, 0n);
assert.equal((await clearing.exposureState(0)).shortBase, 0n);
await (await clearing.setMarketPolicy(0, true, 1_000_000_000_000n, 5_000_000_000_000n)).wait();
await configure(50_000_000_000n, 20_000_000_000n);
await refresh();
await trade(long, BASE / 10n);
await trade(short, -BASE / 100n);
prices[0] = 150_000_000_000n;
await refresh();
await trade(long, -BASE / 10n, 0, true);
assert((await clearing.makerBacking()) < 100_000_000_000n);
await assert.rejects(
  trade(third, BASE / 100n),
  "realized maker losses must enforce capital floor on later opening",
);
await assert.rejects(
  clearing.connect(third).declareResolution(),
  "an unreported incident must not resolve the venue",
);
await (await clearing.connect(third).reportMakerIncident()).wait();
assert((await clearing.makerIncidentSince()) > 0n);
await assert.rejects(clearing.connect(third).reportMakerIncident(), "an incident is reported once");
await assert.rejects(
  clearing.connect(third).declareResolution(),
  "resolution must wait for the incident grace period",
);
const grace = Number(await clearing.makerIncidentGracePeriod());
const recovery = await ethers.provider.send("evm_snapshot", []);
await (await clearing.connect(maker).fundMaker(50_000_000_000n)).wait();
await refresh();
await (await clearing.connect(third).clearMakerIncident()).wait();
assert.equal(await clearing.makerIncidentSince(), 0n, "recapitalization clears the incident");
await ethers.provider.send("evm_increaseTime", [grace]);
await ethers.provider.send("evm_mine", []);
await refresh();
await assert.rejects(
  clearing.connect(third).declareResolution(),
  "a cleared incident cannot resolve the venue",
);
await ethers.provider.send("evm_revert", [recovery]);
await ethers.provider.send("evm_increaseTime", [grace]);
await ethers.provider.send("evm_mine", []);
await refresh();
await (await clearing.connect(third).declareResolution()).wait();
assert.equal(
  await clearing.resolutionRequired(),
  true,
  "a persistent objective undercapitalization must permit permissionless resolution",
);
console.log(
  "Exposure E2E passed: capital floor, opposing gross, independent sides, stale gross marks, reductions and permissionless incident entry after the grace period",
);
