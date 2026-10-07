import type { Market, Side } from "./markets.js";

type Entry = { id: string; price: bigint; sequence: number };

class Heap {
  private entries: Entry[] = [];
  constructor(private preferred: (left: Entry, right: Entry) => boolean) {}
  get size() {
    return this.entries.length;
  }
  peek() {
    return this.entries[0];
  }
  push(entry: Entry) {
    this.entries.push(entry);
    let index = this.entries.length - 1;
    while (index > 0) {
      const parent = (index - 1) >> 1;
      if (!this.preferred(entry, this.entries[parent])) break;
      this.entries[index] = this.entries[parent];
      index = parent;
    }
    this.entries[index] = entry;
  }
  pop() {
    const root = this.entries[0],
      tail = this.entries.pop();
    if (!root || !tail || this.entries.length === 0) return root;
    let index = 0;
    while (true) {
      const left = index * 2 + 1;
      if (left >= this.entries.length) break;
      const right = left + 1;
      let child =
        right < this.entries.length && this.preferred(this.entries[right], this.entries[left]) ? right : left;
      if (!this.preferred(this.entries[child], tail)) break;
      this.entries[index] = this.entries[child];
      index = child;
    }
    this.entries[index] = tail;
    return root;
  }
}

export class LimitTriggerBook {
  private sequence = 0;
  private active = new Map<
    string,
    { market: Market; side: Side; price: bigint; deadlineMs: number; sequence: number }
  >();
  private expiries = new Heap(
    (a, b) => a.price < b.price || (a.price === b.price && a.sequence < b.sequence),
  );
  /** Per-market books, created on a market's first order. */
  private books = new Map<Market, Record<Side, Heap>>();
  private book(market: Market) {
    let book = this.books.get(market);
    if (!book)
      this.books.set(
        market,
        (book = {
          buy: new Heap((a, b) => a.price > b.price || (a.price === b.price && a.sequence < b.sequence)),
          sell: new Heap((a, b) => a.price < b.price || (a.price === b.price && a.sequence < b.sequence)),
        }),
      );
    return book;
  }
  add(id: string, market: Market, side: Side, price: bigint, deadlineMs = Number.MAX_SAFE_INTEGER) {
    const entry = { market, side, price, deadlineMs, sequence: ++this.sequence };
    this.active.set(id, entry);
    this.book(market)[side].push({ id, price, sequence: entry.sequence });
    this.expiries.push({ id, price: BigInt(deadlineMs), sequence: entry.sequence });
  }
  remove(id: string) {
    this.active.delete(id);
  }
  has(id: string) {
    return this.active.has(id);
  }
  get size() {
    return this.active.size;
  }
  takeExpired(now = Date.now(), limit = 256) {
    const ids: string[] = [];
    while (ids.length < limit) {
      const top = this.expiries.peek();
      if (!top || top.price > BigInt(now)) break;
      this.expiries.pop();
      const current = this.active.get(top.id);
      if (!current || current.sequence !== top.sequence) continue;
      this.active.delete(top.id);
      ids.push(top.id);
    }
    return ids;
  }
  takeMarketable(market: Market, bid: bigint, ask: bigint, limit = 64) {
    const ids: string[] = [];
    const book = this.books.get(market);
    if (!book) return ids;
    for (const side of ["buy", "sell"] as const) {
      const heap = book[side];
      while (ids.length < limit) {
        const top = heap.peek();
        if (!top) break;
        const current = this.active.get(top.id);
        if (!current || current.sequence !== top.sequence) {
          heap.pop();
          continue;
        }
        const eligible = side === "buy" ? top.price >= ask : top.price <= bid;
        if (!eligible) break;
        heap.pop();
        this.active.delete(top.id);
        ids.push(top.id);
      }
    }
    return ids;
  }
}

/**
 * Armed trigger orders, indexed by trigger price. An order with `triggerAbove` fires once the mid is
 * at or above its price, otherwise once it is at or below. It reuses the limit book: a below-trigger
 * behaves like a resting buy against an ask equal to the mid, an above-trigger like a sell against
 * a bid equal to the mid.
 */
export class StopTriggerBook {
  private readonly book = new LimitTriggerBook();
  add(id: string, market: Market, triggerAbove: boolean, price: bigint, deadlineMs?: number) {
    this.book.add(id, market, triggerAbove ? "sell" : "buy", price, deadlineMs);
  }
  remove(id: string) {
    this.book.remove(id);
  }
  has(id: string) {
    return this.book.has(id);
  }
  get size() {
    return this.book.size;
  }
  takeExpired(now = Date.now(), limit = 256) {
    return this.book.takeExpired(now, limit);
  }
  takeTriggered(market: Market, mid: bigint, limit = 64) {
    return this.book.takeMarketable(market, mid, mid, limit);
  }
}
