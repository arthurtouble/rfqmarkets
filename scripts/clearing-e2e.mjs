import assert from "node:assert/strict";
import fs from "node:fs";
import { network } from "hardhat";

const { ethers } = await network.create({ network: "hardhatOp", chainType: "op" });
const [governance, emergency, approverA, approverB, approverC, maker, user, keeper, relayer] = await ethers.getSigners();
const artifact = (name) => JSON.parse(fs.readFileSync(`artifacts/${name}.json`, "utf8"));
const deploy = async (name, args = [], signer = governance) => {
  const item = artifact(name);
  const instance = await new ethers.ContractFactory(item.abi, item.bytecode, signer).deploy(...args);
  await instance.waitForDeployment();
  return instance;
};
const reject = async (promise, label) => {
  let failed = false;
  try { await (await promise).wait(); } catch { failed = true; }
  assert.equal(failed, true, label);
};

const token = await deploy("MockUSDC");
const oracle = await deploy("MockPriceOracle");

// Chainlink v3 adapter verifies the configured feed and normalizes 8 decimals to USDC's 6.
const streamsVerifier = await deploy("MockStreamsVerifier");
const btcFeed = ethers.keccak256(ethers.toUtf8Bytes("BTC/USD"));
const ethFeed = ethers.keccak256(ethers.toUtf8Bytes("ETH/USD"));
const streamsAdapter = await deploy("ChainlinkDataStreamsV3Adapter", [
  await streamsVerifier.getAddress(), governance.address, [btcFeed, ethFeed], [8, 8],
]);
const nowBlock = await ethers.provider.getBlock("latest");
const v3Type = "tuple(bytes32 feedId,uint32 validFromTimestamp,uint32 observationsTimestamp,uint192 nativeFee,uint192 linkFee,uint32 expiresAt,int192 price,int192 bid,int192 ask)";
const verifiedV3 = ethers.AbiCoder.defaultAbiCoder().encode([v3Type], [[
  btcFeed, nowBlock.timestamp, nowBlock.timestamp, 0, 0, nowBlock.timestamp + 60,
  10_000_000_000_000n, 9_999_000_000_000n, 10_001_000_000_000n,
]]);
await (await streamsVerifier.setResponse(verifiedV3)).wait();
const normalized = await streamsAdapter.connect(governance).verify.staticCall("0x1234");
assert.equal(normalized.market, 0n);
assert.equal(normalized.bid, 99_990_000_000n);
await reject(streamsAdapter.connect(user).verify("0x1234"), "only clearing may consume verified stream reports");

const implementation = await deploy("RFQClearing");
const clearingInterface = new ethers.Interface(artifact("RFQClearing").abi);
const init = clearingInterface.encodeFunctionData("initialize", [
  await token.getAddress(), await oracle.getAddress(), governance.address, emergency.address,
  [approverA.address, approverB.address, approverC.address], 600_000_000_000n,
]);
const proxy = await deploy("TestProxy", [await implementation.getAddress(), init]);
const clearing = new ethers.Contract(await proxy.getAddress(), artifact("RFQClearing").abi, governance);

await (await token.mint(maker.address, 750_000_000_000n)).wait();
await (await token.mint(user.address, 20_000_000_000n)).wait();
await (await token.mint(relayer.address, 1_000_000_000n)).wait();
await (await token.mint(keeper.address, 100_000_000n)).wait();
await (await token.connect(maker).approve(await clearing.getAddress(), ethers.MaxUint256)).wait();
await (await token.connect(user).approve(await clearing.getAddress(), ethers.MaxUint256)).wait();
await (await token.connect(relayer).approve(await clearing.getAddress(), ethers.MaxUint256)).wait();
await (await clearing.connect(maker).fundMaker(600_000_000_000n)).wait();
await (await clearing.connect(maker).fundInsurance(150_000_000_000n)).wait();
await (await clearing.connect(user).deposit(7_000_000_000n)).wait();
await (await clearing.connect(relayer).deposit(1_000_000_000n)).wait();
const depositBlock = await ethers.provider.getBlock("latest");
await (await clearing.connect(relayer).depositWithAuthorization(
  keeper.address, 100_000_000n, depositBlock.timestamp - 1, depositBlock.timestamp + 60,
  ethers.keccak256(ethers.toUtf8Bytes("deposit-1")), 27, ethers.ZeroHash, ethers.ZeroHash,
)).wait();
assert.equal(await clearing.collateralOf(keeper.address), 100_000_000n);

const coder = ethers.AbiCoder.defaultAbiCoder();
const observationType = "tuple(uint8 market,uint256 bid,uint256 ask,uint64 observedAt,uint64 validUntil)";
const observation = async (market, bid, ask) => {
  const block = await ethers.provider.getBlock("latest");
  const value = [market, bid, ask, BigInt(block.timestamp), BigInt(block.timestamp + 60)];
  return { value, report: coder.encode([observationType], [value]) };
};
const networkInfo = await ethers.provider.getNetwork();
const domain = { name: "RFQ Markets", version: "1", chainId: networkInfo.chainId, verifyingContract: await clearing.getAddress() };
const intentTypes = { TradeIntent: [
  {name:"account",type:"address"},{name:"market",type:"uint8"},{name:"baseDelta",type:"int256"},
  {name:"limitPrice",type:"uint256"},{name:"maxFee",type:"uint256"},{name:"nonce",type:"uint256"},
  {name:"deadline",type:"uint64"},{name:"leaderEpoch",type:"uint64"},{name:"policyVersion",type:"uint64"},{name:"reduceOnly",type:"bool"},
] };
const approvalTypes = { MakerApproval: [
  {name:"intentHash",type:"bytes32"},{name:"executionPrice",type:"uint256"},{name:"impactCharge",type:"int256"},
  {name:"fee",type:"uint256"},{name:"oracleReportHash",type:"bytes32"},{name:"deadline",type:"uint64"},
  {name:"leaderEpoch",type:"uint64"},{name:"signerSetVersion",type:"uint64"},{name:"policyVersion",type:"uint64"},
] };
async function order({ nonce, delta, executionPrice, limitPrice, impactCharge, report, reduceOnly = false }) {
  const block = await ethers.provider.getBlock("latest");
  const deadline = BigInt(block.timestamp + 60);
  const intent = { account:user.address, market:0, baseDelta:delta, limitPrice, maxFee:10_000_000n, nonce, deadline, leaderEpoch:1n, policyVersion:1n, reduceOnly };
  const userSignature = await user.signTypedData(domain, intentTypes, intent);
  const intentHash = ethers.TypedDataEncoder.hash(domain, intentTypes, intent);
  const approval = { intentHash, executionPrice, impactCharge, fee:2_000_000n, oracleReportHash:ethers.keccak256(report), deadline, leaderEpoch:1n, signerSetVersion:1n, policyVersion:1n };
  return { intent, approval, userSignature, sigA:await approverA.signTypedData(domain,approvalTypes,approval), sigB:await approverB.signTypedData(domain,approvalTypes,approval) };
}

const initialOracle = await observation(0, 99_990_000_000n, 100_010_000_000n);
const opening = await order({ nonce:1n, delta:249_900_000_000_000_000n, executionPrice:100_023_000_000n, limitPrice:100_030_000_000n, impactCharge:3_123_000n, report:initialOracle.report });
await (await clearing.connect(relayer).executeTrade(opening.intent, opening.approval, initialOracle.report, opening.userSignature, opening.sigA, opening.sigB)).wait();
assert.equal((await clearing.positionOf(user.address, 0)).size, 249_900_000_000_000_000n);
assert.equal(await clearing.collateralOf(user.address), 6_998_000_000n);

// Positive unrealized PnL cannot be withdrawn as opening collateral.
const up = await observation(0, 119_990_000_000n, 120_010_000_000n);
await (await clearing.connect(keeper).refreshOracle(up.report)).wait();
await reject(clearing.connect(user).withdraw(1_500_000_000n), "positive unrealized PnL must not fund withdrawal margin");

// Adverse price makes the account liquidatable; liquidation reduces absolute exposure.
const down = await observation(0, 78_990_000_000n, 79_010_000_000n);
await (await clearing.connect(keeper).liquidate(user.address, 0, down.report)).wait();
assert.equal((await clearing.positionOf(user.address, 0)).size, 187_425_000_000_000_000n);
assert((await clearing.insuranceBalance()) > 150_000_000_000n);

// Internal buckets reconcile exactly to tokens held after the keeper reward transfer.
const internal = (await clearing.makerBacking()) + (await clearing.insuranceBalance()) + (await clearing.totalCustomerCollateral());
assert.equal(await token.balanceOf(await clearing.getAddress()), internal);

// Upgrade through the configured governance address while the position remains open.
const v2Implementation = await deploy("RFQClearingV2");
await (await clearing.connect(governance).upgradeToAndCall(await v2Implementation.getAddress(), "0x")).wait();
const upgraded = new ethers.Contract(await clearing.getAddress(), artifact("RFQClearingV2").abi, governance);
assert.equal(await upgraded.implementationVersion(), 2n);
assert.equal((await upgraded.positionOf(user.address, 0)).size, 187_425_000_000_000_000n);

// Deterministic, batched global resolution uses three observations over >=30s.
await (await upgraded.connect(governance).pause()).wait();
await (await upgraded.connect(governance).declareResolution()).wait();
const preBurnBalance = await token.balanceOf(await upgraded.getAddress());
await (await token.burn(await upgraded.getAddress(), preBurnBalance - 2_000_000_000n)).wait();
for (let sample = 0; sample < 3; sample++) {
  const btc = await observation(0, 78_990_000_000n, 79_010_000_000n);
  const eth = await observation(1, 3_990_000_000n, 4_010_000_000n);
  await (await upgraded.connect(keeper).submitResolutionObservation(btc.report)).wait();
  await (await upgraded.connect(keeper).submitResolutionObservation(eth.report)).wait();
  if (sample < 2) {
    await ethers.provider.send("evm_increaseTime", [15]);
    await ethers.provider.send("evm_mine", []);
  }
}
assert.equal(await upgraded.resolutionPricesReady(), true);
await (await upgraded.connect(keeper).processResolution(10)).wait();
assert.equal(await upgraded.resolutionFinalized(), true);
const claim = await upgraded.resolutionClaim(user.address);
const pool = await upgraded.resolutionAssets();
const totalClaims = await upgraded.totalResolutionClaims();
const beforeClaim = await token.balanceOf(user.address);
await (await upgraded.connect(user).claimResolution()).wait();
assert.equal(await token.balanceOf(user.address) - beforeClaim, claim * pool / totalClaims);
const relayerClaim = await upgraded.resolutionClaim(relayer.address);
const relayerBefore = await token.balanceOf(relayer.address);
await (await upgraded.connect(relayer).claimResolution()).wait();
assert.equal(await token.balanceOf(relayer.address) - relayerBefore, relayerClaim * pool / totalClaims);
assert(pool < totalClaims, "fault injection must exercise a real pro-rata haircut");

console.log("Clearing E2E passed: proxy, custody, trade, margin, liquidation, conservation, open-position upgrade, pro-rata resolution");
