import assert from "node:assert/strict";
import { test } from "node:test";
import { LimitTriggerBook } from "./limit-book.js";

test("limit trigger book selects only marketable prices in price-time order", () => {
  const book = new LimitTriggerBook();
  book.add("buy-low", "BTC", "buy", 99n);
  book.add("buy-first", "BTC", "buy", 101n);
  book.add("buy-second", "BTC", "buy", 101n);
  book.add("sell-high", "BTC", "sell", 103n);
  book.add("sell-now", "BTC", "sell", 100n);
  assert.deepEqual(book.takeMarketable("BTC", 100n, 100n), ["buy-first", "buy-second", "sell-now"]);
  assert.equal(book.size, 2);
  assert.deepEqual(book.takeMarketable("BTC", 102n, 98n), ["buy-low"]);
  assert.equal(book.has("sell-high"), true);
});

test("limit trigger book avoids traversing a large dormant book", () => {
  const book = new LimitTriggerBook();
  for (let index = 0; index < 100_000; index++)
    book.add(`order-${index}`, "ETH", index % 2 ? "buy" : "sell", index % 2 ? 1_000n : 10_000n);
  const started = performance.now();
  assert.deepEqual(book.takeMarketable("ETH", 2_000n, 2_001n), []);
  assert(performance.now() - started < 100, "dormant lookup should be heap-head bounded");
  assert.equal(book.size, 100_000);
  book.add("crossing", "ETH", "buy", 2_001n);
  assert.deepEqual(book.takeMarketable("ETH", 2_000n, 2_001n, 1), ["crossing"]);
});

test("limit trigger book expires orders without scanning price books", () => {
  const book = new LimitTriggerBook();
  book.add("later", "BTC", "buy", 1n, 2_000);
  book.add("now", "ETH", "sell", 10n, 1_000);
  book.add("removed", "BTC", "sell", 10n, 500);
  book.remove("removed");
  assert.deepEqual(book.takeExpired(1_500), ["now"]);
  assert.equal(book.has("later"), true);
  assert.equal(book.size, 1);
});
