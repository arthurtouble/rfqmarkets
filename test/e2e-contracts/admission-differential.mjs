// Differential test: the approvers' independent exposure model against the clearing contract, on random trades
// across two markets with stored prices of random ages and reports that price one or both markets.
//
// The approvers refuse to sign what their model rejects, so wherever the model is stricter than the contract a
// trade the contract would settle can never happen (dev, November 2026: every cross-margin trade after an idle
// spell lost approver quorum). Wherever it is looser, the venue signs trades that revert. This replays both sides
// on the same state and requires them to agree on stale-price rejections, the check that diverged.
import assert from "node:assert/strict";
import { network } from "hardhat";
import {
  deployClearing,
  deployLinked,
  encodeObservation,
  launchMarkets,
  BASE,
} from "../../scripts/lib/contract-fixture.mjs";
import { exposureAdmission } from "../../packages/shared/src/exposure-admission.ts";
import { markedMarkets } from "../../services/approver/src/exposure-policy.ts";

const { ethers } = await network.create({ network: "hardhatOp", chainType: "op" });
const [gov, emergency, a, b, c, maker, ...traders] = await ethers.getSigners(),
  users = traders.slice(0, 3),
  libraries = {};
const deploy = (name, args = []) => deployLinked(gov, name, args, libraries);
const token = await deploy("MockUSDC"),
  oracle = await deploy("MockPriceOracle"),
  risk = await deploy("RFQRiskMath");
libraries.RFQRiskMath = await risk.getAddress();
libraries.RFQSignatureVerifier = await (await deploy("RFQSignatureVerifier")).getAddress();
const { clearing } = await deployClearing({
  deployer: gov,
  governance: gov,
  usdc: await token.getAddress(),
  oracle: await oracle.getAddress(),
  emergencyCouncil: emergency.address,
  approvers: [a.address, b.address, c.address],
  baseRiskCapitalTarget: 100_000_000_000n,
  markets: launchMarkets(),
  libraries,
});
const clearingAddress = await clearing.getAddress();
await (await token.mint(maker.address, 10_000_000_000_000n)).wait();
await (await token.connect(maker).approve(clearingAddress, ethers.MaxUint256)).wait();
await (await clearing.connect(maker).fundMaker(10_000_000_000_000n)).wait();
for (const user of users) {
  await (await token.mint(user.address, 1_000_000_000_000n)).wait();
  await (await token.connect(user).approve(clearingAddress, ethers.MaxUint256)).wait();
  await (await clearing.connect(user).deposit(1_000_000_000_000n)).wait();
}

// Deterministic PRNG so a failure replays: RFQ_DIFFERENTIAL_SEED picks another sequence.
let seed = BigInt(process.env.RFQ_DIFFERENTIAL_SEED ?? "20261103");
const random = () => {
  seed = (seed * 6364136223846793005n + 1442695040888963407n) & ((1n << 64n) - 1n);
  return Number(seed >> 11n) / 2 ** 53;
};
const pick = (items) => items[Math.floor(random() * items.length)];

const IMPACT_K = [10_000, 12_000],
  mids = [100_000_000_000n, 4_000_000_000n];
const domain = {
  name: "RFQ Markets",
  version: "1",
  chainId: (await ethers.provider.getNetwork()).chainId,
  verifyingContract: clearingAddress,
};
const intentTypes = {
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
const STALE = clearing.interface.getError("Stale").selector;
const revertData = (error) => error?.data ?? error?.info?.error?.data ?? error?.error?.data;
let nonce = 0n;

/** The trade as the contract receives it; `covered` lists the markets the report prices (the intent market first). */
async function build(user, market, delta, covered, observedAt) {
  const mid = mids[market],
    state = await clearing.markets(market),
    impact = await risk.impactCost(
      IMPACT_K[market],
      (state.aggregateBase * mid) / BASE,
      (delta * mid) / BASE,
    ),
    charge = impact > 0n ? impact : 0n,
    size = delta < 0n ? -delta : delta,
    premium = (charge * BASE + size - 1n) / size,
    price = mid + (delta > 0n ? premium : -premium);
  const report = encodeObservation(
    [...covered]
      .sort((x, y) => x - y)
      .map((index) => ({
        market: index,
        bid: mids[index],
        ask: mids[index],
        observedAt,
        validUntil: observedAt + 60,
      })),
  );
  const intent = {
      account: user.address,
      market,
      baseDelta: delta,
      limitPrice: price,
      maxFee: 0n,
      nonce: ++nonce,
      deadline: BigInt(observedAt + 60),
      reduceOnly: false,
    },
    approval = {
      intentHash: ethers.TypedDataEncoder.hash(domain, intentTypes, intent),
      executionPrice: price,
      impactCharge: charge,
      fee: 0n,
      oracleReportHash: ethers.keccak256(report),
      deadline: intent.deadline,
      leaderEpoch: await clearing.leaderEpoch(),
      signerSetVersion: await clearing.signerSetVersion(),
      policyVersion: await clearing.policyVersion(),
    };
  return [
    intent,
    approval,
    report,
    await user.signTypedData(domain, intentTypes, intent),
    await a.signTypedData(domain, approvalTypes, approval),
    await b.signTypedData(domain, approvalTypes, approval),
  ];
}

/** The approvers' model on the same state: chain markets re-marked by the report, then exposureAdmission. */
async function modelSaysStale(user, market, delta, covered, observedAt, timestamp) {
  const count = Number(await clearing.marketCount()),
    markets = [],
    books = [];
  for (let i = 0; i < count; i++) {
    const m = await clearing.markets(i),
      book = await clearing.exposure(i);
    markets.push({
      aggregateBase: m.aggregateBase,
      fundingIndex: m.fundingIndex,
      fundingTime: m.fundingTime,
      lastPriceTime: m.lastPriceTime,
      lastBid: m.lastBid,
      lastAsk: m.lastAsk,
      enabled: m.enabled,
    });
    // Caps are not under test here: open them so only freshness decides.
    books.push({ longBase: book.longBase, shortBase: book.shortBase, limits: (1n << 255n) - 1n });
  }
  const position = await clearing.positionOf(user.address, market);
  const observations = new Map(
    covered.map((index) => [
      index,
      {
        market: BigInt(index),
        bid: mids[index],
        ask: mids[index],
        observedAt: BigInt(observedAt),
        validUntil: 0n,
      },
    ]),
  );
  const marked = markedMarkets(
    { markets },
    market,
    { bid: mids[market], ask: mids[market] },
    BigInt(observedAt),
    observations,
  );
  const admission = exposureAdmission({
    markets: marked,
    books,
    netLimits: marked.map(() => (1n << 255n) - 1n),
    market,
    position: {
      size: position.size,
      entryPrice: position.entryPrice,
      lastFundingIndex: position.lastFundingIndex,
    },
    delta,
    executionPrice: mids[market],
    timestamp: BigInt(timestamp),
    backing: 10n ** 30n,
  });
  return admission.reason === "stale_gross_price";
}

const STEPS = Number(process.env.RFQ_DIFFERENTIAL_STEPS ?? "160");
const tally = { agreeStale: 0, agreeFresh: 0, executed: 0 };
for (let step = 0; step < STEPS; step++) {
  // Ages either well inside or well past the contract's 15 s, so block-time jitter cannot flip a case.
  const advance = pick([0, 0, 2, 6, 9, 22, 30, 45]);
  if (advance) await ethers.provider.send("evm_increaseTime", [advance]);
  await ethers.provider.send("evm_mine", []);
  const user = pick(users),
    market = pick([0, 1]),
    other = 1 - market,
    covered = random() < 0.5 ? [market, other] : [market];
  const position = (await clearing.positionOf(user.address, market)).size;
  const unit = market === 0 ? BASE / 1_000n : BASE / 40n;
  let delta;
  if (position !== 0n && random() < 0.45) {
    // A reduction: buy back or sell part (or all) of the position.
    const part = (position * BigInt(1 + Math.floor(random() * 10))) / 10n;
    delta = part === 0n ? -position : -part;
  } else delta = unit * BigInt(1 + Math.floor(random() * 20)) * (random() < 0.5 ? 1n : -1n);
  const head = await ethers.provider.getBlock("latest"),
    observedAt = head.timestamp,
    // eth_call runs in a block one second after the head.
    timestamp = head.timestamp + 1;
  const args = await build(user, market, delta, covered, observedAt);
  let contractStale = false,
    contractOk = false;
  try {
    await clearing.executeTrade.staticCall(...args);
    contractOk = true;
  } catch (error) {
    contractStale = String(revertData(error) ?? "").startsWith(STALE);
  }
  const model = await modelSaysStale(user, market, delta, covered, observedAt, timestamp);
  assert.equal(
    model,
    contractStale,
    `step ${step}: model ${model ? "rejects" : "accepts"} a stale price where the contract ${
      contractStale ? "reverts Stale" : contractOk ? "settles" : "reverts otherwise"
    } (market ${market}, delta ${delta}, position ${position}, report prices ${covered.join("+")}, advanced ${advance} s)`,
  );
  if (model) tally.agreeStale++;
  else tally.agreeFresh++;
  if (contractOk && random() < 0.8) {
    await (await clearing.executeTrade(...args)).wait();
    tally.executed++;
  }
}
assert.ok(
  tally.agreeStale > 5 && tally.agreeFresh > 20,
  `too few cases of each kind: ${JSON.stringify(tally)}`,
);
console.log(
  `Admission differential passed: ${STEPS} random trades, model and contract agree (${tally.agreeStale} stale rejections, ${tally.agreeFresh} admitted, ${tally.executed} settled)`,
);
