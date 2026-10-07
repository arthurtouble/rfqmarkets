import assert from "node:assert/strict";
import { test } from "node:test";
import { JsonRpcProvider, Wallet } from "ethers";
import { accountView } from "./account.js";
import { buildApi } from "./server.js";

const USDC = 1_000_000n,
  BASE = 10n ** 18n;
const markets = {
  BTC: {
    bid: String(99_990n * USDC),
    ask: String(100_010n * USDC),
    mid: String(100_000n * USDC),
    projectedFundingIndex: "0",
  },
  ETH: {
    bid: String(3_999n * USDC),
    ask: String(4_001n * USDC),
    mid: String(4_000n * USDC),
    projectedFundingIndex: "0",
  },
};
const flat = { size: 0n, entryPrice: 0n, lastFundingIndex: 0n };

test("liquidation estimates sit below the mid for longs and above it for shorts", () => {
  const long = accountView(
      50_000n * USDC,
      { BTC: { size: BASE, entryPrice: 100_000n * USDC, lastFundingIndex: 0n }, ETH: flat },
      markets,
    ),
    short = accountView(
      50_000n * USDC,
      { BTC: flat, ETH: { size: -10n * BASE, entryPrice: 4_000n * USDC, lastFundingIndex: 0n } },
      markets,
    );
  const longPrice = BigInt(long.positions.BTC.estimatedLiquidationPrice!),
    shortPrice = BigInt(short.positions.ETH.estimatedLiquidationPrice!);
  assert(longPrice > 0n && longPrice < 100_000n * USDC, String(longPrice));
  assert(shortPrice > 4_000n * USDC && shortPrice < 80_000n * USDC, String(shortPrice));
  assert.equal(long.positions.ETH.estimatedLiquidationPrice, undefined);
  assert.equal(long.liquidatable, false);
});

test("margin and liquidation estimates use each market's margin multiplier", () => {
  const position = {
      BTC: { size: BASE / 10n, entryPrice: 100_000n * USDC, lastFundingIndex: 0n },
      ETH: flat,
    },
    base = accountView(1_000n * USDC, position, markets),
    scaled = accountView(1_000n * USDC, position, {
      BTC: { ...markets.BTC, marginScaleBps: 2_500 },
      ETH: { ...markets.ETH, marginScaleBps: 2_500 },
    });
  // 0.1 BTC at the 100,010 ask: 10,001 USDC in the first tier (20% / 12%, or 5% / 3% at 0.25x).
  assert.equal(base.initialMargin, "2000200000");
  assert.equal(scaled.initialMargin, "500050000");
  assert.equal(scaled.maintenanceMargin, "300030000");
  assert.equal(scaled.positions.BTC.initialMargin, "500050000");
  assert.deepEqual(scaled.marginParameters.BTC, {
    marginScaleBps: 2_500,
    maxLeverage: 20,
    initialMarginBps: 500,
    maintenanceMarginBps: 300,
  });
  assert.equal(base.marginParameters.ETH.maxLeverage, 5);
  // Lower maintenance margin moves a long's liquidation price further below the mid.
  assert(
    BigInt(scaled.positions.BTC.estimatedLiquidationPrice!) <
      BigInt(base.positions.BTC.estimatedLiquidationPrice!),
  );
});

class UnavailableChain extends JsonRpcProvider {
  override async send(): Promise<never> {
    throw new Error("connect ECONNREFUSED 10.0.0.1:8545");
  }
}

test("account and action reads separate invalid input (400) from an unavailable chain (503)", async () => {
  const clearing = "0x0000000000000000000000000000000000000001",
    provider = new UnavailableChain(),
    app = buildApi({
      provider,
      chainId: 84_532n,
      verifyingContract: clearing,
      chain: {
        rpcUrl: "https://unused",
        sponsorPrivateKey: Wallet.createRandom().privateKey,
        clearingAddress: clearing,
        tokenAddress: clearing,
      },
      sender: {
        reconcile: async () => {},
        status: () => [],
        submit: async () => {
          throw new Error("unused");
        },
      },
    }),
    account = Wallet.createRandom().address;
  try {
    await app.ready();
    const invalid = await app.inject({ url: "/v1/account/not-an-address" });
    assert.equal(invalid.statusCode, 400);
    const unavailable = await app.inject({ url: `/v1/account/${account}` });
    assert.equal(unavailable.statusCode, 503, unavailable.body);
    assert.doesNotMatch(unavailable.body, /ECONNREFUSED|10\.0\.0\.1/);

    const prepare = (payload: Record<string, unknown>) =>
      app.inject({ method: "POST", url: "/v1/withdraw/prepare", payload });
    assert.equal((await prepare({ account, amount: "0", nonce: "1" })).statusCode, 400);
    assert.equal((await prepare({ account: "0x1234", amount: "1", nonce: "1" })).statusCode, 400);
    const outage = await prepare({ account, amount: "1", nonce: "1" });
    assert.equal(outage.statusCode, 503, outage.body);
    assert.doesNotMatch(outage.body, /ECONNREFUSED|10\.0\.0\.1/);
  } finally {
    await app.close();
  }
});
