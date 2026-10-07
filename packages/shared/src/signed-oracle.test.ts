import assert from "node:assert/strict";
import { test } from "node:test";
import { AbiCoder, Wallet, getAddress, keccak256, solidityPacked, toUtf8Bytes } from "ethers";
import {
  SignedOracleClient,
  combineBatches,
  decodeSignedReport,
  encodeSignedReport,
  priceBatchDigest,
  priceBatchToWire,
  priceBatchTypedData,
  recoverBatchSigner,
  signPriceBatch,
  type PriceBatch,
  type SignedPriceBatch,
} from "./signed-oracle.js";

// Well-known Hardhat development keys; never funded outside local chains.
const KEYS = [
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
  "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6",
];
const wallets = KEYS.map((key) => new Wallet(key));
const signers = wallets.slice(0, 3).map((wallet) => wallet.address);
const domain = { chainId: 8453, verifyingContract: "0x000000000000000000000000000000000000dEaD" };
const vector: PriceBatch = {
  observedAt: 1_700_000_000,
  prices: [
    { market: 0, bid: 60_000_000_000n, ask: 60_010_000_000n },
    { market: 1, bid: 3_000_000_000n, ask: 3_001_000_000n },
  ],
};
/** Fixed EIP-712 test vector shared with the SignedPriceOracle Solidity tests. */
const EXPECTED_DIGEST = "0xfa5f674f239e7f1ef584d02a4a987a5af9bfd307847fd9a50276624f4707f4be";

/** Independent re-derivation of the digest the way the contract builds it with abi.encode/keccak. */
function manualDigest(batch: PriceBatch) {
  const coder = AbiCoder.defaultAbiCoder();
  const priceTypehash = keccak256(toUtf8Bytes("Price(uint8 market,uint256 bid,uint256 ask)"));
  const batchTypehash = keccak256(
    toUtf8Bytes("PriceBatch(uint64 observedAt,Price[] prices)Price(uint8 market,uint256 bid,uint256 ask)"),
  );
  const priceHashes = batch.prices.map((price) =>
    keccak256(
      coder.encode(
        ["bytes32", "uint8", "uint256", "uint256"],
        [priceTypehash, price.market, price.bid, price.ask],
      ),
    ),
  );
  const structHash = keccak256(
    coder.encode(
      ["bytes32", "uint64", "bytes32"],
      [
        batchTypehash,
        batch.observedAt,
        keccak256(
          solidityPacked(
            priceHashes.map(() => "bytes32"),
            priceHashes,
          ),
        ),
      ],
    ),
  );
  const domainSeparator = keccak256(
    coder.encode(
      ["bytes32", "bytes32", "bytes32", "uint256", "address"],
      [
        keccak256(
          toUtf8Bytes("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
        ),
        keccak256(toUtf8Bytes("RFQ Markets Oracle")),
        keccak256(toUtf8Bytes("1")),
        domain.chainId,
        domain.verifyingContract,
      ],
    ),
  );
  return keccak256(solidityPacked(["bytes2", "bytes32", "bytes32"], ["0x1901", domainSeparator, structHash]));
}

test("EIP-712 digest matches the fixed vector and the manual derivation", async () => {
  const digest = priceBatchDigest(domain, vector);
  console.log(`SignedPriceOracle EIP-712 test vector digest: ${digest}`);
  assert.equal(digest, manualDigest(vector));
  assert.equal(digest, EXPECTED_DIGEST);
  const signed = await signPriceBatch(wallets[0], domain, vector);
  console.log(`  signer ${wallets[0].address} signature ${signed.signature}`);
  assert.equal(signed.signature.length, 132);
  assert.equal(recoverBatchSigner(domain, signed), wallets[0].address);
  assert.equal(
    recoverBatchSigner({ ...domain, chainId: 1 }, signed) === wallets[0].address,
    false,
    "the domain binds the chain",
  );
  assert.notEqual(
    recoverBatchSigner(domain, { ...signed, prices: [{ ...signed.prices[0], bid: 1n }, signed.prices[1]] }),
    wallets[0].address,
  );
});

test("typed data rejects unsorted, duplicate, crossed and non-positive prices", () => {
  const bad = (prices: PriceBatch["prices"]) => () => priceBatchTypedData(domain, { observedAt: 1, prices });
  assert.throws(bad([vector.prices[1], vector.prices[0]]), /ascending/);
  assert.throws(bad([vector.prices[0], vector.prices[0]]), /ascending/);
  assert.throws(bad([{ market: 0, bid: 2n, ask: 1n }]), /bid\/ask/);
  assert.throws(bad([{ market: 0, bid: 0n, ask: 1n }]), /bid\/ask/);
  assert.throws(bad([{ market: 256, bid: 1n, ask: 1n }]), /market/);
  assert.doesNotThrow(bad([{ market: 0, bid: 1n, ask: 1n }]));
});

test("report encoding round-trips through the on-chain ABI shape", async () => {
  const batches = await Promise.all(
    wallets.slice(0, 2).map((wallet) => signPriceBatch(wallet, domain, vector)),
  );
  const report = encodeSignedReport(batches);
  assert.deepEqual(decodeSignedReport(report), batches);
  const [raw] = AbiCoder.defaultAbiCoder().decode(
    ["tuple(uint64 observedAt,tuple(uint8 market,uint256 bid,uint256 ask)[] prices,bytes signature)[]"],
    report,
  );
  assert.equal(raw.length, 2);
  assert.equal(raw[1].prices[1].ask, 3_001_000_000n);
  assert.deepEqual(decodeSignedReport(encodeSignedReport([])), []);
});

const sign = (index: number, observedAt: number, prices: PriceBatch["prices"]) =>
  signPriceBatch(wallets[index], domain, { observedAt, prices });
const options = { domain, signers, threshold: 2, maxDeviationBps: 50, maxSkewSeconds: 3 };
const btc = (bid: bigint, ask: bigint) => ({ market: 0, bid, ask });
const eth = (bid: bigint, ask: bigint) => ({ market: 1, bid, ask });

test("combineBatches takes medians over the batches carrying each market", async () => {
  const batches = [
    await sign(0, 100, [btc(100_000_000n, 100_020_000n), eth(10_000_000n, 10_010_000n)]),
    await sign(1, 101, [btc(100_010_000n, 100_030_000n), eth(10_001_000n, 10_011_000n)]),
    await sign(2, 101, [btc(100_005_000n, 100_025_001n)]),
  ];
  const combined = combineBatches(batches, options)!;
  assert.deepEqual(
    combined.signers,
    [...signers].sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : 1)),
    "batches are ordered by signer",
  );
  assert.equal(combined.batches.length, 3);
  assert.equal(combined.observedAt, 100);
  assert.equal(combined.validUntil, 115);
  // BTC: three batches, odd count -> middle values.
  assert.deepEqual(combined.prices[0], { market: 0, bid: 100_005_000n, ask: 100_025_001n, signers: 3 });
  // ETH: two batches, even count -> bid averaged down, ask averaged up.
  assert.deepEqual(combined.prices[1], { market: 1, bid: 10_000_500n, ask: 10_010_500n, signers: 2 });
  const odd = combineBatches(
    [
      await sign(0, 100, [eth(10_000_000n, 10_010_000n)]),
      await sign(1, 100, [eth(10_000_001n, 10_010_002n)]),
    ],
    options,
  )!;
  assert.deepEqual(odd.prices[0], { market: 1, bid: 10_000_000n, ask: 10_010_001n, signers: 2 });
  assert.deepEqual(decodeSignedReport(encodeSignedReport(combined.batches)), combined.batches);
});

test("combineBatches enforces the signer threshold and ignores unknown or duplicate signers", async () => {
  const one = await sign(0, 100, [btc(100_000_000n, 100_020_000n)]);
  assert.equal(combineBatches([one], options), undefined);
  assert.equal(
    combineBatches([one, await sign(0, 99, [btc(100_000_000n, 100_020_000n)])], options),
    undefined,
  );
  const outsider = await sign(3, 100, [btc(100_000_000n, 100_020_000n)]);
  assert.equal(combineBatches([one, outsider], options), undefined, "unauthorized signer does not count");
  const forged: SignedPriceBatch = {
    ...(await sign(1, 100, [btc(1n, 2n)])),
    prices: [btc(100_000_000n, 100_020_000n)],
  };
  assert.equal(combineBatches([one, forged], options), undefined, "a tampered batch does not count");
  const newer = await sign(0, 102, [btc(100_000_000n, 100_020_000n)]),
    second = await sign(1, 101, [btc(100_000_000n, 100_020_000n)]);
  const combined = combineBatches([one, newer, second], options)!;
  assert.deepEqual(
    combined.batches.map((batch) => batch.observedAt).sort(),
    [101, 102],
    "the newest batch per signer is used",
  );
  // A market carried by only one of the chosen batches has no consensus.
  const partial = combineBatches(
    [await sign(0, 100, [btc(100_000_000n, 100_020_000n), eth(1_000n, 1_001n)]), second],
    options,
  )!;
  assert.deepEqual(
    partial.prices.map((price) => price.market),
    [0],
  );
});

test("combineBatches rejects markets whose batch mids disagree beyond maxDeviationBps", async () => {
  const base = await sign(0, 100, [btc(100_000_000n, 100_000_000n), eth(10_000_000n, 10_000_000n)]);
  // BTC 50 bps apart (allowed, inclusive), ETH 51 bps apart (rejected).
  const other = await sign(1, 100, [btc(100_500_000n, 100_500_000n), eth(10_051_000n, 10_051_000n)]);
  const combined = combineBatches([base, other], options)!;
  assert.deepEqual(
    combined.prices.map((price) => price.market),
    [0],
  );
  const wide = await sign(1, 100, [btc(100_600_000n, 100_600_000n)]);
  assert.equal(combineBatches([base, wide], { ...options }), undefined);
});

test("combineBatches keeps only batches within maxSkewSeconds", async () => {
  const prices = [btc(100_000_000n, 100_020_000n)];
  const old = await sign(0, 100, prices),
    a = await sign(1, 110, prices),
    b = await sign(2, 112, prices);
  const combined = combineBatches([old, a, b], options)!;
  assert.deepEqual(combined.batches.map((batch) => batch.observedAt).sort(), [110, 112]);
  assert.equal(combined.observedAt, 110);
  assert.equal(combineBatches([old, a], options), undefined, "two batches 10 s apart do not combine");
  assert.equal(
    combineBatches([old, await sign(1, 103, prices)], options)!.batches.length,
    2,
    "skew is inclusive",
  );
});

test("SignedOracleClient combines node batches from REST and SSE and expires stale reports", async () => {
  const nowMs = { value: 101_000 };
  const batches = [
    await sign(0, 100, [btc(100_000_000n, 100_020_000n)]),
    await sign(1, 101, [btc(100_010_000n, 100_030_000n)]),
    await sign(2, 101, [btc(100_020_000n, 100_040_000n)]),
  ];
  const wire = batches.map((batch, index) => priceBatchToWire(batch, signers[index]));
  const nodes = ["http://node-0", "http://node-1", "http://node-2"];
  const fetchImpl = (async (input: string | URL) => {
    const url = String(input),
      index = nodes.findIndex((node) => url.startsWith(node));
    if (url.endsWith("/v1/batch/latest")) {
      if (index === 2) return new Response("down", { status: 503 });
      return Response.json(wire[index]);
    }
    if (url.endsWith("/v1/batch/stream") && index === 2)
      return new Response(`: hi\n\nevent: batch\ndata: ${JSON.stringify(wire[2])}\n\n`, {
        headers: { "content-type": "text/event-stream" },
      });
    return new Response("no stream", { status: 404 });
  }) as typeof fetch;
  const client = new SignedOracleClient({
    ...options,
    nodes,
    fetchImpl,
    reconnectMs: 5,
    now: () => nowMs.value,
  });
  await client.start();
  for (let attempt = 0; attempt < 100 && client.status()[2].observedAt === null; attempt++)
    await new Promise((resolve) => setTimeout(resolve, 5));
  await client.close();
  const latest = client.latest()!;
  assert.equal(latest.signers.length, 3);
  assert.equal(latest.validUntil, 115);
  assert.deepEqual(latest.prices, [{ market: 0, bid: 100_010_000n, ask: 100_030_000n, signers: 3 }]);
  assert.equal(decodeSignedReport(latest.report).length, 3);
  assert.equal(client.accept(nodes[0], { ...wire[0], signature: wire[1].signature }), false);
  assert.ok(client.status()[0].rejected >= 1);
  nowMs.value = 115_000;
  assert.equal(client.latest(), undefined, "a report past validUntil is not served");
  assert.equal(getAddress(latest.signers[0]), latest.signers[0]);
});
