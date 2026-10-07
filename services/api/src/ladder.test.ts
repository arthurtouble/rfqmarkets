import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { buildApi } from "./server.js";

let api: ReturnType<typeof buildApi>;

before(async () => {
  api = buildApi({});
  await api.ready();
});

after(async () => {
  await api.close();
});

test("the quote ladder prices both sides at each size, worse with size, without storing quotes", async () => {
  const response = await api.inject({ url: "/v1/quote/ladder?market=BTC&amounts=1000,10000,50000" });
  assert.equal(response.statusCode, 200, response.body);
  const ladder = response.json();
  assert.equal(ladder.market, "BTC");
  assert.equal(ladder.buy.length, 3);
  assert.equal(ladder.sell.length, 3);
  assert.deepEqual(
    ladder.buy.map((rung: { amount: string }) => rung.amount),
    ["1000.000000", "10000.000000", "50000.000000"],
  );
  const buys = ladder.buy.map((rung: { price: string }) => BigInt(rung.price)),
    sells = ladder.sell.map((rung: { price: string }) => BigInt(rung.price)),
    mid = BigInt(ladder.mid);
  for (let index = 1; index < 3; index++) {
    assert(buys[index] >= buys[index - 1], "larger buys never price better");
    assert(sells[index] <= sells[index - 1], "larger sells never price better");
  }
  assert(buys[0] > mid && sells[0] < mid);
});

test("the ladder defaults its sizes and rejects bad requests", async () => {
  const defaults = (await api.inject({ url: "/v1/quote/ladder?market=ETH" })).json();
  assert.equal(defaults.buy.length + defaults.sell.length > 0, true);
  for (const query of [
    "market=DOGE",
    "market=BTC&amounts=1,2,3,4,5,6,7",
    "market=BTC&amounts=0",
    "market=BTC&amounts=abc",
  ])
    assert.equal((await api.inject({ url: `/v1/quote/ladder?${query}` })).statusCode, 400, query);
});
