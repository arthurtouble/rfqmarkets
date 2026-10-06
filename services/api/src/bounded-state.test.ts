import assert from "node:assert/strict";
import test from "node:test";
import { ExpiryIndex, PendingExposureBook } from "./bounded-state.js";

test("expiry index returns only due live entries in bounded batches", () => {
  const index = new ExpiryIndex();
  for (let i = 0; i < 100_000; i++) index.schedule(`future-${i}`, 10_000 + i);
  index.schedule("due-a", 5);
  index.schedule("due-b", 6);
  index.schedule("rescheduled", 4);
  index.schedule("rescheduled", 20_000);
  assert.deepEqual(index.takeExpired(9, 1), ["due-a"]);
  assert.deepEqual(index.takeExpired(9, 1), ["due-b"]);
  assert.deepEqual(index.takeExpired(9, 1), []);
});

test("pending exposure maintains conservative low and high totals", () => {
  const book = new PendingExposureBook();
  book.add("a", { market: "BTC", delta: 10n, expiresAtMs: 10 });
  book.add("b", { market: "BTC", delta: -4n, expiresAtMs: 20 });
  book.add("c", { market: "ETH", delta: 7n, expiresAtMs: 30 });
  assert.deepEqual(book.exposure(), [
    { market: "BTC", delta: -4n },
    { market: "BTC", delta: 10n },
    { market: "ETH", delta: 7n },
  ]);
  book.add("a", { market: "BTC", delta: 3n, expiresAtMs: 40 });
  book.prune(25);
  assert.deepEqual(book.exposure(), [
    { market: "BTC", delta: 3n },
    { market: "ETH", delta: 7n },
  ]);
  book.delete("c");
  assert.deepEqual(book.envelope(), [{ market: "BTC", delta: "3" }]);
});
