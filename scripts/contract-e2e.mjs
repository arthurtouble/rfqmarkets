import assert from "node:assert/strict";
import fs from "node:fs";
import { network } from "hardhat";

const { ethers } = await network.create({ network: "hardhatOp", chainType: "op" });
const [governance, approverA, approverB, approverC, user, relayer] = await ethers.getSigners();
const artifact = JSON.parse(fs.readFileSync("artifacts/RFQAuthorization.json", "utf8"));
const factory = new ethers.ContractFactory(artifact.abi, artifact.bytecode, governance);
const contract = await factory.deploy(
  governance.address,
  [approverA.address, approverB.address, approverC.address],
  600_000_000_000n,
);
await contract.waitForDeployment();

const invariantArtifact = JSON.parse(fs.readFileSync("artifacts/RFQInvariants.json", "utf8"));
const invariantFactory = new ethers.ContractFactory(invariantArtifact.abi, invariantArtifact.bytecode, governance);
const invariants = await invariantFactory.deploy();
await invariants.waitForDeployment();

const address = await contract.getAddress();
const net = await ethers.provider.getNetwork();
const domain = { name: "RFQ Markets", version: "1", chainId: net.chainId, verifyingContract: address };
const intentTypes = { TradeIntent: [
  { name: "account", type: "address" }, { name: "market", type: "uint8" },
  { name: "notionalDelta", type: "int256" }, { name: "limitPrice", type: "uint256" },
  { name: "maxFee", type: "uint256" }, { name: "nonce", type: "uint256" },
  { name: "deadline", type: "uint64" },
] };
const approvalTypes = { MakerApproval: [
  { name: "intentHash", type: "bytes32" }, { name: "executionPrice", type: "uint256" },
  { name: "impactCharge", type: "int256" }, { name: "fee", type: "uint256" },
  { name: "oracleReportHash", type: "bytes32" }, { name: "deadline", type: "uint64" },
  { name: "leaderEpoch", type: "uint64" }, { name: "signerSetVersion", type: "uint64" },
  { name: "policyVersion", type: "uint64" },
] };

async function signedOrder({ nonce, delta, impactCharge, epoch = 1n, market = 0, limitPrice = 100_000_000_000n, executionPrice = 99_990_000_000n }) {
  const block = await ethers.provider.getBlock("latest");
  const deadline = BigInt(block.timestamp + 120);
  const intent = {
    account: user.address, market, notionalDelta: delta, limitPrice,
    maxFee: 100_000_000n, nonce, deadline,
  };
  const userSignature = await user.signTypedData(domain, intentTypes, intent);
  const intentHash = ethers.TypedDataEncoder.hash(domain, intentTypes, intent);
  const approval = {
    intentHash, executionPrice, impactCharge, fee: 20_000_000n,
    oracleReportHash: ethers.keccak256(ethers.toUtf8Bytes(`report-${nonce}`)), deadline,
    leaderEpoch: epoch, signerSetVersion: 1n, policyVersion: 1n,
  };
  return {
    intent, approval, userSignature,
    sigA: await approverA.signTypedData(domain, approvalTypes, approval),
    sigB: await approverB.signTypedData(domain, approvalTypes, approval),
  };
}

async function mustReject(promise, label) {
  let rejected = false;
  try { await (await promise).wait(); } catch { rejected = true; }
  assert.equal(rejected, true, label);
}

// Distinct signer enforcement.
const duplicate = await signedOrder({ nonce: 1n, delta: 10_000_000_000n, impactCharge: 1_000_000_000n });
await mustReject(
  contract.connect(relayer).authorizeAndApply(duplicate.intent, duplicate.approval, duplicate.userSignature, duplicate.sigA, duplicate.sigA),
  "duplicate approver signature must fail",
);

// Deterministic contract-level fuzz sample for arithmetic invariants.
let seed = 0x9e3779b9;
for (let i = 0; i < 200; i++) {
  seed = (Math.imul(seed ^ (seed >>> 16), 0x45d9f3b) + i) >>> 0;
  const first = BigInt(seed) * 1_000_003n;
  seed = (Math.imul(seed ^ (seed >>> 16), 0x45d9f3b) + i + 1) >>> 0;
  const second = BigInt(seed) * 1_000_033n;
  await invariants.invariant_partitionCannotResetImpact(first, second);
  await invariants.invariant_crossMarketPotentialIsNonnegative(
    BigInt.asIntN(128, first << 48n), BigInt.asIntN(128, second << 48n),
  );
}

// The API and approvers cannot execute beyond the user's bound.
const worseThanLimit = await signedOrder({
  nonce: 5n,
  delta: 1_000_000_000n,
  impactCharge: 1_000_000_000n,
  limitPrice: 100_000_000_000n,
  executionPrice: 100_000_000_001n,
});
await mustReject(
  contract.connect(relayer).authorizeAndApply(
    worseThanLimit.intent, worseThanLimit.approval, worseThanLimit.userSignature,
    worseThanLimit.sigA, worseThanLimit.sigB,
  ),
  "worse-than-limit fill must fail",
);

// A valid gas-sponsored execution changes exposure and consumes the user's nonce.
const first = await signedOrder({ nonce: 2n, delta: 25_000_000_000n, impactCharge: 10_000_000_000n });
await (await contract.connect(relayer).authorizeAndApply(first.intent, first.approval, first.userSignature, first.sigA, first.sigB)).wait();
assert.equal(await contract.btcExposure(), 25_000_000_000n);
await mustReject(
  contract.connect(relayer).authorizeAndApply(first.intent, first.approval, first.userSignature, first.sigA, first.sigB),
  "nonce replay must fail",
);

// A quote priced against empty inventory cannot execute after an earlier fill.
const stale = await signedOrder({ nonce: 3n, delta: 10_000_000_000n, impactCharge: 1n });
await mustReject(
  contract.connect(relayer).authorizeAndApply(stale.intent, stale.approval, stale.userSignature, stale.sigA, stale.sigB),
  "stale impact charge must fail",
);

// Epoch change fences every approval issued by the old API leader.
const oldEpoch = await signedOrder({ nonce: 4n, delta: -1_000_000_000n, impactCharge: 1_000_000_000n, limitPrice:99_000_000_000n });
await (await contract.connect(governance).advanceEpoch()).wait();
await mustReject(
  contract.connect(relayer).authorizeAndApply(oldEpoch.intent, oldEpoch.approval, oldEpoch.userSignature, oldEpoch.sigA, oldEpoch.sigB),
  "old leader epoch must fail",
);
const renewedApproval = { ...oldEpoch.approval, leaderEpoch:2n };
const renewedA = await approverA.signTypedData(domain, approvalTypes, renewedApproval);
const renewedB = await approverB.signTypedData(domain, approvalTypes, renewedApproval);
await (await contract.connect(relayer).authorizeAndApply(oldEpoch.intent, renewedApproval, oldEpoch.userSignature, renewedA, renewedB)).wait();
assert.equal(await contract.leaderEpoch(),2n,"fresh operator approval should execute the unchanged user intent");

console.log("Contract E2E passed: quorum, user limit, sponsorship, replay, state floor, epoch fencing, 400 arithmetic invariant calls");
