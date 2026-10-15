import assert from "node:assert/strict";
import { test } from "node:test";
import { serverFrom, sessionVenue } from "./main.js";
import { accountTools, dollars, readTools, toAmount, type Venue } from "./tools.js";

const USDC = 1_000_000n;
const row = (market: string, mid: bigint, over: Record<string, unknown> = {}) => ({
  market,
  bid: (mid - USDC).toString(),
  ask: (mid + USDC).toString(),
  mid: mid.toString(),
  enabled: true,
  canBuy: true,
  canSell: true,
  maxLeverage: 20,
  observedAtMs: 1,
  ...over,
});

function stub() {
  const calls: Array<[string, unknown]> = [];
  const fill = (market: string, amount: string) => ({
    quote: {
      market,
      amount: BigInt(Math.round(Number(amount) * 1e6)).toString(),
      expectedPrice: (2_500n * USDC).toString(),
      fee: "0",
    },
    transaction: { hash: "0xabc", collateral: (90n * USDC).toString() },
  });
  const venue: Venue = {
    markets: async () => ({
      markets: {
        BTC: row("BTC", 100_000n * USDC),
        ETH: row("ETH", 2_500n * USDC, { maxLeverage: 5 }),
        DOGE: row("DOGE", USDC / 5n, { canSell: false }),
        OLD: row("OLD", USDC, { enabled: false }),
      },
    }),
    quote: async (input) => {
      calls.push(["quote", input]);
      return {
        market: input.market,
        amount: BigInt(Math.round(Number(input.amount) * 1e6)).toString(),
        expectedPrice: (2_501n * USDC).toString(),
        worstPrice: (2_510n * USDC).toString(),
        fee: "0",
        expiresAtMs: 5,
      };
    },
    account: async () => ({
      collateral: (100n * USDC).toString(),
      equity: (112n * USDC).toString(),
      availableMargin: (80n * USDC).toString(),
      positions: {
        ETH: {
          size: (-(10n ** 17n)).toString(),
          entryPrice: (2_600n * USDC).toString(),
          markPrice: (2_480n * USDC).toString(),
          notional: (248n * USDC).toString(),
          unrealizedPnl: (12n * USDC).toString(),
          accruedFunding: "0",
          initialMargin: (50n * USDC).toString(),
          estimatedLiquidationPrice: null,
        },
        BTC: {
          size: "0",
          entryPrice: "0",
          markPrice: "0",
          notional: "0",
          unrealizedPnl: "0",
          accruedFunding: "0",
          initialMargin: "0",
        },
      },
    }),
    trade: async (input) => (calls.push(["trade", input]), fill(input.market, input.amount)),
    close: async (input) => (calls.push(["close", input]), fill(input.market, "10")),
    closeAll: async () => (calls.push(["closeAll", undefined]), [fill("ETH", "10")]),
    tpsl: async (input) => (calls.push(["tpsl", input]), [{}, {}]),
  };
  const tools = [...readTools(venue), ...accountTools(venue, { maxStake: 50, maxMultiplier: 10 })];
  const run = (name: string, args: Record<string, unknown> = {}) =>
    tools.find((tool) => tool.name === name)!.run(args) as Promise<any>;
  return { calls, run };
}

test("amounts convert between dollars and the API's 6-decimal strings", () => {
  assert.equal(dollars("1234560000"), 1234.56);
  assert.equal(toAmount(30), "30");
  assert.equal(toAmount(12.5), "12.5");
  assert.equal(toAmount(0.1 + 0.2), "0.3");
  assert.equal(toAmount(1.0000004), "1");
});

test("markets list the open ones in dollars", async () => {
  const { run } = stub();
  const markets = await run("list_markets");
  assert.deepEqual(
    markets.map((m: any) => m.market),
    ["BTC", "ETH", "DOGE"],
  );
  assert.deepEqual(markets[2], { market: "DOGE", price: 0.2, maxMultiplier: 20, up: true, down: false });
  assert.deepEqual(await run("get_price", { market: "btc" }), {
    market: "BTC",
    price: 100_000,
    upPrice: 100_001,
    downPrice: 99_999,
    observedAtMs: 1,
  });
  await assert.rejects(run("get_price", { market: "XYZ" }), /unknown market XYZ/);
});

test("a bet trades stake times multiplier on the matching side", async () => {
  const { run, calls } = stub();
  const result = await run("open_bet", { market: "BTC", direction: "down", stake: 25, multiplier: 3 });
  assert.deepEqual(calls.at(-1), ["trade", { market: "BTC", side: "sell", amount: "75" }]);
  assert.equal(result.transaction, "0xabc");
  assert.equal(result.positionSize, 75);
  assert.equal(result.balance, 90);
  await run("open_bet", { market: "ETH", direction: "up", stake: 10 });
  assert.deepEqual(calls.at(-1), ["trade", { market: "ETH", side: "buy", amount: "10" }]);

  const quote = await run("quote_bet", { market: "ETH", direction: "up", stake: 20, multiplier: 2 });
  assert.equal(quote.price, 2_501);
  assert.equal(quote.positionSize, 40);
  assert.equal(quote.fee, 0);
});

test("bets outside the server's limits or the market's are refused before trading", async () => {
  const { run, calls } = stub();
  const bet = (args: Record<string, unknown>) =>
    run("open_bet", { market: "BTC", direction: "up", stake: 10, ...args });
  await assert.rejects(bet({ stake: 51 }), /above this server's limit of \$50/);
  await assert.rejects(bet({ multiplier: 11 }), /above 10×/);
  await assert.rejects(bet({ market: "ETH", multiplier: 6 }), /above 5×/);
  await assert.rejects(bet({ multiplier: 0.5 }), /at least 1/);
  await assert.rejects(bet({ stake: -1 }), /stake must be a positive number/);
  await assert.rejects(bet({ direction: "sideways" }), /"up" or "down"/);
  await assert.rejects(bet({ market: "DOGE", direction: "down" }), /not taking down bets/);
  await assert.rejects(bet({ market: "OLD" }), /not taking up bets/);
  assert.equal(calls.length, 0);
});

test("the account shows open bets with their result", async () => {
  const { run } = stub();
  assert.deepEqual(await run("get_account"), {
    balance: 100,
    equity: 112,
    available: 80,
    bets: [
      {
        market: "ETH",
        direction: "down",
        positionSize: 248,
        entryPrice: 2_600,
        price: 2_480,
        pnl: 12,
        returnPct: 24,
        liquidationPrice: null,
      },
    ],
  });
});

test("closing and protecting map to the venue's fractions and prices", async () => {
  const { run, calls } = stub();
  await run("close_bet", { market: "eth" });
  assert.deepEqual(calls.at(-1), ["close", { market: "ETH", fraction: 10_000 }]);
  await run("close_bet", { market: "ETH", percent: 25 });
  assert.deepEqual(calls.at(-1), ["close", { market: "ETH", fraction: 2_500 }]);
  await assert.rejects(run("close_bet", { market: "ETH", percent: 150 }), /100 or less/);
  assert.equal((await run("close_all")).length, 1);
  const protectedBet = await run("protect_bet", { market: "ETH", stopLoss: 2_700.5 });
  assert.deepEqual(calls.at(-1), ["tpsl", { market: "ETH", stopLossPrice: "2700.5" }]);
  assert.deepEqual(protectedBet, { market: "ETH", takeProfit: null, stopLoss: 2_700.5, orders: 2 });
  await assert.rejects(run("protect_bet", { market: "ETH" }), /takeProfit, stopLoss or both/);
});

test("without a key the server only offers prices and quotes", () => {
  const readOnly = serverFrom({});
  assert.deepEqual(
    readOnly.tools.map((tool) => tool.name),
    ["list_markets", "get_price", "quote_bet"],
  );
  const trading = serverFrom({
    RFQ_PRIVATE_KEY: "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
    RFQ_MCP_MAX_STAKE: "5",
  });
  assert.equal(trading.tools.length, 8);
  assert.match(trading.tools.find((tool) => tool.name === "open_bet")!.description, /up to \$5 /);
  assert.throws(
    () =>
      serverFrom({
        RFQ_PRIVATE_KEY: "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
        RFQ_MCP_MAX_STAKE: "-1",
      }),
    /positive/,
  );
});

test("with RFQ_ACCOUNT the key trades for that account as a session key", async () => {
  const owner = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
    session = serverFrom({
      RFQ_PRIVATE_KEY: "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
      RFQ_ACCOUNT: owner.toLowerCase(),
    });
  assert.ok(!session.tools.some((tool) => tool.name === "protect_bet"));
  assert.equal(session.tools.length, 7);
  assert.match(session.info.instructions!, new RegExp(`account ${owner} with a session key`));
  assert.throws(() => serverFrom({ RFQ_ACCOUNT: owner }), /needs RFQ_PRIVATE_KEY/);

  const calls: Array<[string, unknown]> = [],
    record = (name: string) => async (input?: unknown) => {
      calls.push([name, input]);
      return {};
    },
    venue = sessionVenue(
      {
        markets: record("markets"),
        quote: record("quote"),
        account: record("account"),
        trade: record("trade"),
        close: record("close"),
        closeAll: record("closeAll"),
      } as never,
      owner,
    );
  await venue.trade({ market: "ETH", side: "buy", amount: "10" });
  await venue.close({ market: "ETH" });
  await venue.closeAll();
  await venue.account();
  assert.deepEqual(calls, [
    ["trade", { market: "ETH", side: "buy", amount: "10", account: owner }],
    ["close", { market: "ETH", account: owner }],
    ["closeAll", { account: owner }],
    ["account", owner],
  ]);
  await assert.rejects(venue.tpsl({ market: "ETH" }), /session key cannot/);
});
