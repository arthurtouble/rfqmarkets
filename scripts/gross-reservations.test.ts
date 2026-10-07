import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { GrossReservationBook, type GrossReservation } from "../packages/shared/src/gross-reservations.js";
import {
  initializeGrossJournal,
  persistGross,
  releaseGross,
  restoreGross,
  finalizeGross,
  bindGrossContext,
} from "../packages/shared/src/gross-reservation-journal.js";
import { finalizedClock } from "../packages/shared/src/finalized-clock.js";
const BASE = 10n ** 18n,
  word = (gross: bigint, side = gross) => gross | (side << 128n),
  item = (baseDelta: bigint, reduceOnly = false, deadline = 100, makerDebit = 0n): GrossReservation => ({
    market: 0,
    baseDelta,
    reduceOnly,
    deadline,
    makerDebit,
  });
const books = () =>
  [
    { longBase: 0n, shortBase: 0n, limits: word(20_000_000_000n), ready: true },
    { longBase: 0n, shortBase: 0n, limits: word(20_000_000_000n), ready: true },
  ] as const;
test("opposing approvals reserve gross independently; retries bind inputs and never double count", () => {
  const book = new GrossReservationBook(),
    state = books(),
    asks: [bigint, bigint] = [100_000_000_000n, 4_000_000_000n];
  book.reserve("buy", item(BASE / 10n));
  book.reserve("sell", item(-BASE / 10n));
  assert.equal(book.admit("next", item(BASE / 100n), [...state], asks, 1), false);
  assert.equal(book.admit("buy", item(BASE / 10n), [...state], asks, 1), true);
  book.reserve("buy", item(BASE / 10n, false, 110));
  assert.equal(book.bounds()[0].longBase, BASE / 10n);
  assert.throws(() => book.reserve("buy", item(BASE / 5n)), /mismatch/);
  assert.throws(() => book.reserve("buy", item(BASE / 10n, true)), /mismatch/);
  assert.equal(
    book.admit("close", item(-BASE / 10n, true), [...state], asks, 1),
    true,
    "signed reduceOnly must retain capacity for safe exits",
  );
  book.reserve("close", item(-BASE / 10n, true));
  assert.equal(book.bounds()[0].shortBase, BASE / 10n);
});
test("an unsigned reservation can be released durably and is not restored", () => {
  const database = new DatabaseSync(":memory:");
  initializeGrossJournal(database);
  const book = new GrossReservationBook(),
    state = books(),
    asks: [bigint, bigint] = [100_000_000_000n, 4_000_000_000n];
  book.reserve("unsigned", item(BASE / 10n, false, 100, 5n));
  persistGross(database, "unsigned", item(BASE / 10n, false, 100, 5n));
  book.reserve("kept", item(-BASE / 20n, false, 100, 3n));
  persistGross(database, "kept", item(-BASE / 20n, false, 100, 3n));
  assert.equal(book.admit("next", item(BASE / 10n), [...state], asks, 1), false);
  assert.equal(book.release("unsigned"), true);
  releaseGross(database, "unsigned");
  assert.equal(book.release("unsigned"), false, "release is idempotent");
  assert.equal(book.bounds()[0].longBase, 0n);
  assert.equal(book.capitalDebit(), 3n);
  assert.equal(book.admit("next", item(BASE / 10n), [...state], asks, 1), true);
  assert.deepEqual(book.finalize(1, 1_000), ["kept"], "a released id leaves no stale expiry entry");
  const restored = new GrossReservationBook();
  restoreGross(database, restored);
  assert.equal(restored.get("unsigned"), undefined);
  assert.equal(restored.size, 1);
  database.close();
});
test("escaped approvals reserve every net/stress execution subset and maker floor", () => {
  const baseBooks = [
      { longBase: 0n, shortBase: 0n, limits: word(100_000_000n), ready: true },
      { longBase: 0n, shortBase: 0n, limits: word(100_000_000n), ready: true },
    ] as [ReturnType<typeof books>[number], ReturnType<typeof books>[number]],
    asks: [bigint, bigint] = [100_000_000n, 4_000_000n],
    netLimits: [bigint, bigint] = [word(15_000_000n), word(15_000_000n)];
  const netBook = new GrossReservationBook(),
    risk = { net: [0n, 0n] as [bigint, bigint], netLimits, backing: 1_000_000_000n, floor: 100_000_000n };
  assert(netBook.admit("one", item(BASE / 10n), baseBooks, asks, 1, risk));
  netBook.reserve("one", item(BASE / 10n));
  assert.equal(
    netBook.admit("two", item(BASE / 10n), baseBooks, asks, 1, risk),
    false,
    "a subset can exceed the net cap",
  );
  assert(
    netBook.admit("opposite", item(-BASE / 10n), baseBooks, asks, 1, risk),
    "opposing optionality remains inside both net extremes",
  );
  const stressBook = new GrossReservationBook(),
    wide = {
      ...risk,
      netLimits: [word(1_000_000_000n), word(1_000_000_000n)] as [bigint, bigint],
      backing: 20_000_000n,
      floor: 10_000_000n,
    };
  assert(stressBook.admit("one", item(BASE / 10n), baseBooks, asks, 1, wide));
  stressBook.reserve("one", item(BASE / 10n));
  assert.equal(
    stressBook.admit("two", item(BASE / 10n), baseBooks, asks, 1, wide),
    false,
    "a subset can exceed maker stress capacity",
  );
  assert.equal(
    new GrossReservationBook().admit("floor", item(BASE / 100n), baseBooks, asks, 1, {
      ...wide,
      backing: 9_999_999n,
    }),
    false,
  );
});
test("escaped approvals reserve maker debit even when reduce-only reserves no gross", () => {
  const state = books(),
    asks: [bigint, bigint] = [100_000_000_000n, 4_000_000_000n],
    risk = {
      net: [0n, 0n] as [bigint, bigint],
      netLimits: [word(1_000_000_000n), word(1_000_000_000n)] as [bigint, bigint],
      backing: 500_000_000n,
      floor: 100_000_000n,
    },
    book = new GrossReservationBook();
  assert(book.admit("first", item(BASE / 100n, true, 100, 250_000_000n), [...state], asks, 1, risk));
  book.reserve("first", item(BASE / 100n, true, 100, 250_000_000n));
  assert.equal(book.bounds()[0].shortBase, 0n);
  assert.equal(book.capitalDebit(), 250_000_000n);
  assert.equal(
    book.admit("second", item(BASE / 100n, false, 100, 200_000_001n), [...state], asks, 1, risk),
    false,
  );
});
test("expiry requires finalized time strictly past deadline, persists across restart and rejects stale snapshots", () => {
  const db = new DatabaseSync(":memory:");
  initializeGrossJournal(db);
  let book = new GrossReservationBook();
  persistGross(db, "escaped", item(BASE / 10n));
  book.reserve("escaped", item(BASE / 10n));
  // Inclusion does not delete capacity. Restart reconstructs the signed risk.
  book = new GrossReservationBook();
  restoreGross(db, book);
  assert.equal(book.bounds()[0].longBase, BASE / 10n);
  finalizeGross(db, book, 10, 100);
  assert.equal(book.size, 1, "deadline equality is still executable");
  assert.equal(
    book.admit("new", item(BASE / 10n), [...books()], [100_000_000_000n, 4_000_000_000n], 9),
    false,
  );
  finalizeGross(db, book, 11, 101);
  assert.equal(book.size, 0);
  const restored = new GrossReservationBook();
  restoreGross(db, restored);
  assert.equal(restored.size, 0);
  assert.equal(restored.finalizedBlock, 11);
  assert.equal(
    restored.admit("lagged", item(BASE / 10n), [...books()], [100_000_000_000n, 4_000_000_000n], 10),
    false,
  );
  assert.throws(() => book.finalize(10, 102), /regression/);
  assert.throws(() => book.finalize(12, 99), /regression/);
  db.close();
});
test("journal transaction failure cannot leave an escaped reservation partially written", () => {
  const db = new DatabaseSync(":memory:");
  initializeGrossJournal(db);
  db.exec(
    'CREATE TABLE signatures(id TEXT);CREATE TRIGGER fail_signature BEFORE INSERT ON signatures BEGIN SELECT RAISE(ABORT,"injected");END',
  );
  db.exec("BEGIN IMMEDIATE");
  try {
    persistGross(db, "lost", item(BASE / 10n));
    db.prepare("INSERT INTO signatures VALUES(?)").run("lost");
    assert.fail("expected trigger failure");
  } catch {
    db.exec("ROLLBACK");
  }
  assert.equal(db.prepare("SELECT COUNT(*) count FROM gross_reservations").get()!.count, 0);
  persistGross(db, "bound", item(BASE / 10n));
  assert.throws(() => persistGross(db, "bound", item(-BASE / 10n)), /mismatch/);
  assert.throws(
    () => persistGross(db, "corrupt", { ...item(BASE / 10n), reduceOnly: "false" } as never),
    /invalid/,
  );
  db.close();
});
test("failed finalized archival keeps durable and in-memory capacity reserved", () => {
  const db = new DatabaseSync(":memory:");
  initializeGrossJournal(db);
  const book = new GrossReservationBook();
  persistGross(db, "escaped", item(BASE / 10n));
  book.reserve("escaped", item(BASE / 10n));
  assert.throws(
    () =>
      finalizeGross(db, book, 1, 101, undefined, () => {
        throw new Error("injected archive failure");
      }),
    /injected/,
  );
  assert.equal(book.size, 1);
  assert.equal(book.bounds()[0].longBase, BASE / 10n);
  assert.equal(db.prepare("SELECT COUNT(*) count FROM gross_reservations").get()!.count, 1);
  assert.equal(db.prepare("SELECT COUNT(*) count FROM gross_clock").get()!.count, 0);
  finalizeGross(db, book, 1, 101);
  assert.equal(book.size, 0);
  assert.equal(db.prepare("SELECT COUNT(*) count FROM gross_reservations").get()!.count, 0);
  db.close();
});
test("directional reservation envelope bounds execution subsets and account orderings including reduce-only intents", () => {
  let seed = 0x12345678;
  const rand = () => {
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      return seed >>> 0;
    },
    abs = (v: bigint) => (v < 0n ? -v : v);
  for (let trial = 0; trial < 128; trial++) {
    const initial = Array.from({ length: 4 }, () => BigInt(rand() % 21) - 10n),
      intents = Array.from({ length: 8 }, () => ({
        account: rand() % 4,
        delta: BigInt((rand() % 20) + 1) * (rand() % 2 ? 1n : -1n),
        reduceOnly: rand() % 3 === 0,
      })),
      book = new GrossReservationBook();
    intents.forEach((intent, i) => book.reserve(String(i), item(intent.delta, intent.reduceOnly)));
    const bound = book.bounds()[0],
      longBound = initial.reduce((s, v) => s + (v > 0n ? v : 0n), 0n) + bound.longBase,
      shortBound = initial.reduce((s, v) => s + (v < 0n ? -v : 0n), 0n) + bound.shortBase;
    for (let mask = 0; mask < 256; mask++)
      for (const reverse of [false, true]) {
        const positions = [...initial],
          sequence = reverse ? [...intents].reverse() : intents;
        for (let i = 0; i < 8; i++) {
          const index = reverse ? 7 - i : i;
          if (!(mask & (1 << index))) continue;
          const intent = sequence[i],
            old = positions[intent.account],
            next = old + intent.delta;
          if (intent.reduceOnly && !(abs(next) < abs(old) && (next === 0n || next > 0n === old > 0n)))
            continue;
          positions[intent.account] = next;
        }
        const longs = positions.reduce((s, v) => s + (v > 0n ? v : 0n), 0n),
          shorts = positions.reduce((s, v) => s + (v < 0n ? -v : 0n), 0n);
        assert(longs <= longBound && shorts <= shortBound);
      }
  }
});
test("expiry drains bounded batches without scanning the active reservation set", () => {
  const book = new GrossReservationBook();
  for (let i = 0; i < 2000; i++) book.reserve(String(i), item(1n, false, i < 600 ? 100 : 200));
  assert.equal(book.finalize(1, 101).length, 512);
  assert.equal(book.size, 1488);
  assert.equal(book.finalize(1, 101).length, 88);
  assert.equal(book.bounds()[0].longBase, 1400n);
});
test("missing, future or divergent finalized proofs retain reservations", async () => {
  const header = { number: "0xa", timestamp: "0x64", hash: "0x" + "ab".repeat(32) },
    primary = { send: async () => header };
  assert.deepEqual(await finalizedClock(primary as never, 10, 100), {
    block: 10,
    timestamp: 100,
    hash: header.hash,
  });
  assert.equal(await finalizedClock(primary as never, 9, 100), undefined);
  assert.equal(await finalizedClock({ send: async () => null } as never, 10, 100), undefined);
  assert.equal(
    await finalizedClock(
      {
        send: async () => {
          throw new Error("offline");
        },
      } as never,
      10,
      100,
    ),
    undefined,
  );
  assert.equal(
    await finalizedClock(primary as never, 10, 100, {
      send: async () => ({ ...header, hash: "0x" + "cd".repeat(32) }),
    } as never),
    undefined,
  );
  assert.equal(
    await finalizedClock(primary as never, 10, 100, {
      send: async () => ({ ...header, number: "0x9" }),
    } as never),
    undefined,
  );
});

test("shared expiry index remains bounded through retries and matches a reference under reschedule/cancel interleavings", async () => {
  const { ExpiryIndex } = await import("../packages/shared/src/expiry-index.js"),
    index = new ExpiryIndex();
  for (let i = 0; i < 50_000; i++) index.schedule("retry", i + 1);
  assert.equal(index.size, 1);
  assert.deepEqual(index.takeExpired(49_999), []);
  assert.deepEqual(index.takeExpired(50_000), ["retry"]);
  assert.equal(index.size, 0);
  const reference = new Map<string, number>();
  let seed = 0xabcd1234;
  const rand = () => {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return seed >>> 0;
  };
  for (let step = 0; step < 5000; step++) {
    const id = String(rand() % 100);
    if (rand() % 3 === 0) {
      index.cancel(id);
      reference.delete(id);
    } else {
      const deadline = rand() % 1000;
      index.schedule(id, deadline);
      reference.set(id, deadline);
    }
    if (step % 17 === 0) {
      const now = rand() % 1000,
        actual = index.takeExpired(now, 7);
      assert(actual.length <= 7);
      for (const id of actual) {
        assert(reference.get(id)! <= now);
        reference.delete(id);
      }
      if (actual.length < 7) assert([...reference.values()].every((value) => value > now));
    }
    assert.equal(index.size, reference.size);
  }
});

test("conflicting finalized headers cannot release capacity and checkpoint hashes survive restart", () => {
  const db = new DatabaseSync(":memory:");
  initializeGrossJournal(db);
  const book = new GrossReservationBook(),
    hash = "0x" + "ab".repeat(32);
  finalizeGross(db, book, 20, 200, hash);
  const restored = new GrossReservationBook();
  restoreGross(db, restored);
  assert.equal(restored.finalizedHash, hash);
  assert.throws(() => finalizeGross(db, restored, 20, 200, "0x" + "cd".repeat(32)), /conflicting/);
  assert.throws(() => restored.finalize(20, 201), /conflicting/);
  db.close();
});

test("reservation journal cannot be reused under a different chain/proxy or signing identity", () => {
  const db = new DatabaseSync(":memory:");
  initializeGrossJournal(db);
  bindGrossContext(db, "approver", "84532:proxy:signer-a");
  bindGrossContext(db, "approver", "84532:proxy:signer-a");
  for (const value of ["8453:proxy:signer-a", "84532:other:signer-a", "84532:proxy:signer-b"])
    assert.throws(() => bindGrossContext(db, "approver", value), /context mismatch/);
  db.close();
});
