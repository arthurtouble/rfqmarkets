import assert from "node:assert/strict";
import fs from "node:fs";
import { network } from "hardhat";
import { linkArtifact } from "./link-artifact.mjs";

const { ethers } = await network.create({ network: "hardhatOp", chainType: "op" });
const [governance, emergency, approverA, approverB, approverC, maker, user, keeper, relayer] = await ethers.getSigners();
const artifact = (name) => JSON.parse(fs.readFileSync(`artifacts/${name}.json`, "utf8"));
const libraryAddresses = {};
const deploy = async (name, args = [], signer = governance) => {
  const item = linkArtifact(artifact(name), libraryAddresses);
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
const riskMath = await deploy("RFQRiskMath");
libraryAddresses.RFQRiskMath = await riskMath.getAddress();

// The linked math module is independently testable across increase, reduction, flip and funding edges.
let transition = await riskMath.positionTransition(1_000_000_000_000_000_000n, 100_000_000n, 500_000_000_000_000_000n, 110_000_000n);
assert.deepEqual([...transition], [1_500_000_000_000_000_000n, 103_333_333n, 0n]);
transition = await riskMath.positionTransition(1_000_000_000_000_000_000n, 100_000_000n, -500_000_000_000_000_000n, 110_000_000n);
assert.deepEqual([...transition], [500_000_000_000_000_000n, 100_000_000n, 5_000_000n]);
transition = await riskMath.positionTransition(1_000_000_000_000_000_000n, 100_000_000n, -2_000_000_000_000_000_000n, 90_000_000n);
assert.deepEqual([...transition], [-1_000_000_000_000_000_000n, 90_000_000n, -10_000_000n]);
assert.equal(await riskMath.positionPnl(-2_000_000_000_000_000_000n, 100_000_000n, 90_000_000n), 20_000_000n);
const assessment = await riskMath.tradeAssessment(0n, 0n, 2_000_000_000_000_000_000n, 0, -1_000_000_000_000_000_000n, 99_000_000n, 99_000_000n, 100_000_000n);
assert.equal(assessment.notional,99_000_000n);assert.equal(assessment.deliveredImpact,0n);assert.equal(assessment.reduces,true);
const unchangedFunding = await riskMath.fundingStep(1_000_000_000_000_000_000n, 100_000_000n, 123n, 1_000n, 1_000n, 1_000_000_000n);
assert.deepEqual([...unchangedFunding], [123n, 1_000n]);
const weekFunding = await riskMath.fundingStep(1_000_000_000_000_000_000n, 100_000_000n, 0n, 1_000n, 1_000n + 7n * 86_400n, 1_000_000_000n);
const cappedFunding = await riskMath.fundingStep(1_000_000_000_000_000_000n, 100_000_000n, 0n, 1_000n, 1_000n + 8n * 86_400n, 1_000_000_000n);
assert.deepEqual([...cappedFunding], [...weekFunding]);

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

// Pyth Core is a credential-independent contract option once an authenticated update is acquired.
const pyth = await deploy("MockPythCore");
await (await pyth.setFee(7n)).wait();
await (await pyth.setPrice(btcFeed, [10_000_000_000_000n, 1_000_000_000n, -8, nowBlock.timestamp])).wait();
const pythAdapter = await deploy("PythCoreAdapter", [await pyth.getAddress(), governance.address, [btcFeed, ethFeed]]);
const pythReport = ethers.AbiCoder.defaultAbiCoder().encode(["uint8", "bytes[]"], [0, ["0x1234"]]);
assert.equal(await pythAdapter.updateFee(pythReport), 7n);
const pythObservation = await pythAdapter.connect(governance).verify.staticCall(pythReport, {value:7n});
assert.equal(pythObservation.bid, 99_990_000_000n);
assert.equal(pythObservation.ask, 100_010_000_000n);
await reject(pythAdapter.connect(governance).verify(pythReport, {value:6n}), "Pyth fee must be exact so ETH cannot be trapped");
await reject(pythAdapter.connect(user).verify(pythReport, {value:7n}), "only clearing may consume Pyth reports");

const implementation = await deploy("RFQClearing");
const clearingInterface = new ethers.Interface(artifact("RFQClearing").abi);
const init = clearingInterface.encodeFunctionData("initialize", [
  await token.getAddress(), await oracle.getAddress(), governance.address, emergency.address,
  [approverA.address, approverB.address, approverC.address], 600_000_000_000n,
]);
const proxy = await deploy("TestProxy", [await implementation.getAddress(), governance.address, init]);
const clearing = new ethers.Contract(await proxy.getAddress(), artifact("RFQClearing").abi, governance);
const ADMIN_SLOT="0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103";
const adminWord=await ethers.provider.getStorage(await proxy.getAddress(),ADMIN_SLOT);
const proxyAdminAddress=ethers.getAddress(`0x${adminWord.slice(-40)}`);
const proxyAdmin=new ethers.Contract(proxyAdminAddress,artifact("ProxyAdmin").abi,governance);
assert.equal(await proxyAdmin.owner(),governance.address);

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
  {name:"deadline",type:"uint64"},{name:"reduceOnly",type:"bool"},
] };
const approvalTypes = { MakerApproval: [
  {name:"intentHash",type:"bytes32"},{name:"executionPrice",type:"uint256"},{name:"impactCharge",type:"int256"},
  {name:"fee",type:"uint256"},{name:"oracleReportHash",type:"bytes32"},{name:"deadline",type:"uint64"},
  {name:"leaderEpoch",type:"uint64"},{name:"signerSetVersion",type:"uint64"},{name:"policyVersion",type:"uint64"},
] };
const withdrawalTypes = { WithdrawalIntent: [
  {name:"account",type:"address"},{name:"recipient",type:"address"},{name:"amount",type:"uint256"},
  {name:"nonce",type:"uint256"},{name:"deadline",type:"uint64"},
] };
const cancelTypes = { CancelIntent: [
  {name:"account",type:"address"},{name:"nonce",type:"uint256"},{name:"deadline",type:"uint64"},
] };
const closeTypes = { CloseIntent: [
  {name:"account",type:"address"},{name:"market",type:"uint8"},{name:"nonce",type:"uint256"},{name:"deadline",type:"uint64"},
] };
const sessionGrantTypes = { SessionGrant: [
  {name:"account",type:"address"},{name:"session",type:"address"},{name:"marketMask",type:"uint8"},
  {name:"maxTradeNotional",type:"uint128"},{name:"maxCumulativeNotional",type:"uint128"},{name:"maxFee",type:"uint128"},
  {name:"validUntil",type:"uint64"},{name:"nonce",type:"uint256"},{name:"deadline",type:"uint64"},
] };
async function order({ nonce, delta, executionPrice, limitPrice, impactCharge, report, reduceOnly = false, market = 0, account = user.address, signer = user }) {
  const block = await ethers.provider.getBlock("latest");
  const deadline = BigInt(block.timestamp + 60);
  const intent = { account, market, baseDelta:delta, limitPrice, maxFee:10_000_000n, nonce, deadline, reduceOnly };
  const userSignature = await signer.signTypedData(domain, intentTypes, intent);
  const intentHash = ethers.TypedDataEncoder.hash(domain, intentTypes, intent);
  const approval = { intentHash, executionPrice, impactCharge, fee:2_000_000n, oracleReportHash:ethers.keccak256(report), deadline, leaderEpoch:1n, signerSetVersion:1n, policyVersion:1n };
  return { intent, approval, userSignature, sigA:await approverA.signTypedData(domain,approvalTypes,approval), sigB:await approverB.signTypedData(domain,approvalTypes,approval) };
}

// The emergency council fences a failed API leader without gaining upgrade or fund authority.
const epochSnapshot=await ethers.provider.send("evm_snapshot",[]);
const oldEpochReport=(await observation(0,99_990_000_000n,100_010_000_000n)).report;
const oldEpochOrder=await order({nonce:89n,delta:1_000_000_000_000_000n,executionPrice:100_010_000_000n,limitPrice:100_100_000_000n,impactCharge:0n,report:oldEpochReport});
await reject(clearing.connect(relayer).advanceLeaderEpoch(1),"an arbitrary account cannot promote a leader");
await (await clearing.connect(emergency).advanceLeaderEpoch(1)).wait();
assert.equal(await clearing.leaderEpoch(),2n);
await reject(clearing.connect(emergency).advanceLeaderEpoch(1),"competing promotions must serialize on the expected epoch");
await reject(clearing.connect(relayer).executeTrade(oldEpochOrder.intent,oldEpochOrder.approval,oldEpochReport,oldEpochOrder.userSignature,oldEpochOrder.sigA,oldEpochOrder.sigB),"old leader approvals must be fenced");
assert.equal(await ethers.provider.send("evm_revert",[epochSnapshot]),true);

// Market policy changes invalidate outstanding approvals. Emergency authority can only tighten or disable.
const policySnapshot=await ethers.provider.send("evm_snapshot",[]);
const initialLimitWord=await clearing.marketLimitWord(0),mask=(1n<<128n)-1n;
assert.equal(initialLimitWord&mask,1_000_000_000_000n);assert.equal(initialLimitWord>>128n,5_000_000_000_000n);
await (await clearing.connect(emergency).setMarketPolicy(0,false,25_000_000_000n,250_000_000_000n)).wait();
assert.equal((await clearing.markets(0)).enabled,false);assert.equal(await clearing.policyVersion(),2n);
await reject(clearing.connect(emergency).setMarketPolicy(0,true,25_000_000_000n,250_000_000_000n),"emergency council cannot enable a market");
await reject(clearing.connect(emergency).setMarketPolicy(0,false,25_000_000_001n,250_000_000_000n),"emergency council cannot loosen a limit");
await (await clearing.connect(governance).setMarketPolicy(0,true,1_000_000_000_000n,5_000_000_000_000n)).wait();
assert.equal((await clearing.markets(0)).enabled,true);assert.equal(await clearing.policyVersion(),3n);
await reject(clearing.connect(governance).setMarketPolicy(0,true,1_000_000_000_001n,5_000_000_000_000n),"absolute trade ceiling must hold");
assert.equal(await ethers.provider.send("evm_revert",[policySnapshot]),true);

// Owner actions can be sponsored without granting the sender withdrawal authority.
const actionBlock = await ethers.provider.getBlock("latest");
const actionDeadline = BigInt(actionBlock.timestamp + 120);
const withdrawal = { account:user.address, recipient:relayer.address, amount:100_000_000n, nonce:90n, deadline:actionDeadline };
const withdrawalSignature = await user.signTypedData(domain, withdrawalTypes, withdrawal);
const relayerBeforeWithdrawal = await token.balanceOf(relayer.address);
await (await clearing.connect(keeper).withdrawWithSignature(user.address, relayer.address, withdrawal.amount, withdrawal.nonce, withdrawal.deadline, withdrawalSignature)).wait();
assert.equal(await token.balanceOf(relayer.address) - relayerBeforeWithdrawal, withdrawal.amount);
assert.equal(await clearing.nonceUsed(user.address, withdrawal.nonce), true);
await reject(clearing.connect(keeper).withdrawWithSignature(user.address, relayer.address, withdrawal.amount, withdrawal.nonce, withdrawal.deadline, withdrawalSignature), "relayed withdrawal must not replay");

await (await clearing.connect(user).cancelNonce(91n)).wait();
const cancel = { account:user.address, nonce:92n, deadline:actionDeadline };
const cancelSignature = await user.signTypedData(domain, cancelTypes, cancel);
await (await clearing.connect(relayer).cancelNonceWithSignature(user.address, cancel.nonce, cancel.deadline, cancelSignature)).wait();
assert.equal(await clearing.nonceUsed(user.address, 91n), true);
assert.equal(await clearing.nonceUsed(user.address, 92n), true);

// Maker withdrawals cannot cross the configured capital floor.
await reject(clearing.connect(governance).withdrawMakerExcess(maker.address, 1n), "maker floor must remain locked");
await (await token.mint(maker.address, 10_000_000n)).wait();
await (await clearing.connect(maker).fundMaker(10_000_000n)).wait();
const makerBeforeWithdrawal = await token.balanceOf(maker.address);
await (await clearing.connect(governance).withdrawMakerExcess(maker.address, 10_000_000n)).wait();
assert.equal(await token.balanceOf(maker.address) - makerBeforeWithdrawal, 10_000_000n);

// Contract accounts use ERC-1271 without weakening the signed intent boundary.
const smartWallet=await deploy("Mock1271Wallet",[keeper.address]);
await (await token.mint(await smartWallet.getAddress(),1_000_000_000n)).wait();
const smartDepositBlock=await ethers.provider.getBlock("latest");
await (await clearing.connect(relayer).depositWithAuthorization(await smartWallet.getAddress(),1_000_000_000n,smartDepositBlock.timestamp-1,smartDepositBlock.timestamp+60,ethers.keccak256(ethers.toUtf8Bytes("smart-wallet-deposit")),27,ethers.ZeroHash,ethers.ZeroHash)).wait();
const smartReport=(await observation(0,99_990_000_000n,100_010_000_000n)).report;
const smartOpen=await order({nonce:801n,delta:1_000_000_000_000_000n,executionPrice:100_010_050_000n,limitPrice:100_010_100_000n,impactCharge:50n,report:smartReport,account:await smartWallet.getAddress(),signer:keeper});
await (await clearing.connect(relayer).executeTrade(smartOpen.intent,smartOpen.approval,smartReport,smartOpen.userSignature,smartOpen.sigA,smartOpen.sigB)).wait();
assert.equal((await clearing.positionOf(await smartWallet.getAddress(),0)).size,1_000_000_000_000_000n);
const smartClose=await order({nonce:802n,delta:-1_000_000_000_000_000n,executionPrice:99_990_000_000n,limitPrice:99_980_000_000n,impactCharge:0n,report:smartReport,account:await smartWallet.getAddress(),signer:keeper,reduceOnly:true});
await (await clearing.connect(relayer).executeTrade(smartClose.intent,smartClose.approval,smartReport,smartClose.userSignature,smartClose.sigA,smartClose.sigB)).wait();
assert.equal((await clearing.positionOf(await smartWallet.getAddress(),0)).size,0n);

const initialOracle = await observation(0, 99_990_000_000n, 100_010_000_000n);
const cancelledOrder = await order({ nonce:91n, delta:10_000_000_000_000_000n, executionPrice:100_020_000_000n, limitPrice:100_030_000_000n, impactCharge:1_000_000n, report:initialOracle.report });
await reject(clearing.connect(relayer).executeTrade(cancelledOrder.intent,cancelledOrder.approval,initialOracle.report,cancelledOrder.userSignature,cancelledOrder.sigA,cancelledOrder.sigB),"cancelled nonce must block a later trade");
const opening = await order({ nonce:1n, delta:249_900_000_000_000_000n, executionPrice:100_023_000_000n, limitPrice:100_030_000_000n, impactCharge:3_123_000n, report:initialOracle.report });
await (await clearing.connect(relayer).executeTrade(opening.intent, opening.approval, initialOracle.report, opening.userSignature, opening.sigA, opening.sigB)).wait();
assert.equal((await clearing.positionOf(user.address, 0)).size, 249_900_000_000_000_000n);
assert.equal(await clearing.collateralOf(user.address), 6_898_000_000n);

// A scoped key trades without another owner popup but cannot escape its on-chain limits.
const session=ethers.Wallet.createRandom();const sessionBlock=await ethers.provider.getBlock("latest");
const grant={account:relayer.address,session:session.address,marketMask:2,maxTradeNotional:1_100_000_000n,maxCumulativeNotional:1_100_000_000n,maxFee:3_000_000n,validUntil:BigInt(sessionBlock.timestamp+3600),nonce:94n,deadline:BigInt(sessionBlock.timestamp+60)};
const grantSignature=await relayer.signTypedData(domain,sessionGrantTypes,grant);
await (await clearing.connect(keeper).grantSessionWithSignature(grant,grantSignature)).wait();
const ethReport=await observation(1,3_999_000_000n,4_001_000_000n);
const sessionOrder=await order({nonce:95n,delta:250_000_000_000_000_000n,executionPrice:4_006_000_000n,limitPrice:4_010_000_000n,impactCharge:1_000_000n,report:ethReport.report,market:1,account:relayer.address,signer:session});
await (await clearing.connect(keeper).executeTrade(sessionOrder.intent,sessionOrder.approval,ethReport.report,sessionOrder.userSignature,sessionOrder.sigA,sessionOrder.sigB)).wait();
assert.equal((await clearing.sessions(session.address)).usedNotional,1_001_500_000n);
const overCumulative=await order({nonce:96n,delta:250_000_000_000_000_000n,executionPrice:4_010_000_000n,limitPrice:4_020_000_000n,impactCharge:1_500_000n,report:ethReport.report,market:1,account:relayer.address,signer:session});
await reject(clearing.connect(keeper).executeTrade(overCumulative.intent,overCumulative.approval,ethReport.report,overCumulative.userSignature,overCumulative.sigA,overCumulative.sigB),"session cumulative notional must be enforced");
const sessionWithdrawal={account:relayer.address,recipient:session.address,amount:1n,nonce:97n,deadline:BigInt(sessionBlock.timestamp+60)};
const sessionWithdrawalSignature=await session.signTypedData(domain,withdrawalTypes,sessionWithdrawal);
await reject(clearing.connect(keeper).withdrawWithSignature(relayer.address,session.address,1n,97n,sessionWithdrawal.deadline,sessionWithdrawalSignature),"session must not authorize withdrawals");
await (await clearing.connect(relayer).revokeSession(session.address)).wait();
assert.equal((await clearing.sessions(session.address)).account,ethers.ZeroAddress);

// Positive unrealized PnL cannot be withdrawn as opening collateral.
const up = await observation(0, 119_990_000_000n, 120_010_000_000n);
await (await clearing.connect(keeper).refreshOracle(up.report)).wait();
await reject(clearing.connect(user).withdraw(1_500_000_000n), "positive unrealized PnL must not fund withdrawal margin");

// Adverse price makes the account liquidatable; liquidation reduces absolute exposure.
const down = await observation(0, 78_990_000_000n, 79_010_000_000n);
await (await clearing.connect(keeper).liquidate(user.address, 0, down.report)).wait();
assert.equal((await clearing.positionOf(user.address, 0)).size, 187_425_000_000_000_000n);
assert((await clearing.insuranceBalance()) > 150_000_000_000n);
await reject(clearing.connect(user).closePosition(0,down.report),"fallback close must only operate while trading is paused");

// Internal buckets reconcile exactly to tokens held after the keeper reward transfer.
const internal = (await clearing.makerBacking()) + (await clearing.insuranceBalance()) + (await clearing.totalCustomerCollateral());
assert.equal(await token.balanceOf(await clearing.getAddress()), internal);

// Upgrade through the configured governance address while the position remains open.
const v2Implementation = await deploy("RFQClearingV2");
await reject(proxyAdmin.connect(user).upgradeAndCall(await proxy.getAddress(),await v2Implementation.getAddress(),"0x"),"only governance may use ProxyAdmin");
await (await proxyAdmin.connect(governance).upgradeAndCall(await proxy.getAddress(),await v2Implementation.getAddress(), "0x")).wait();
const upgraded = new ethers.Contract(await clearing.getAddress(), artifact("RFQClearingV2").abi, governance);
assert.equal(await upgraded.implementationVersion(), 2n);
assert.equal((await upgraded.positionOf(user.address, 0)).size, 187_425_000_000_000_000n);

// Deterministic, batched global resolution uses three observations over >=30s.
await (await upgraded.connect(governance).pause()).wait();
const closeBlock = await ethers.provider.getBlock("latest");
const closeIntent = { account:user.address, market:0, nonce:93n, deadline:BigInt(closeBlock.timestamp + 60) };
const closeSignature = await user.signTypedData(domain, closeTypes, closeIntent);
const closeReport = await observation(0, 78_990_000_000n, 79_010_000_000n);
await (await upgraded.connect(relayer).closePositionWithSignature(user.address, 0, closeIntent.nonce, closeIntent.deadline, closeReport.report, closeSignature)).wait();
assert.equal((await upgraded.positionOf(user.address, 0)).size, 0n);
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

console.log("Clearing E2E passed: proxy, custody, ERC-1271, scoped sessions, relayed exits, epoch failover, maker floor, trade, margin, liquidation, upgrade, resolution");
