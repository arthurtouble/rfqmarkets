import { ExpiryIndex } from "./expiry-index.js";
import { marketStress, type ExposureBook } from "./exposure-admission.js";
import { MAX_MARKETS, marketRegistry } from "./markets.js";
import { BASE, abs, high128, low128 } from "./numeric.js";

export interface GrossReservation {
  /** Market index (`TradeIntent.market`). */
  market: number;
  baseDelta: bigint;
  reduceOnly: boolean;
  deadline: number;
  makerDebit: bigint;
}
/** Settled net notional, packed net limit words and maker capital used for capital/stress admission. */
export interface GrossRiskContext {
  /** Per market index. */
  net: readonly bigint[];
  netLimits: readonly bigint[];
  backing: bigint;
  floor: bigint;
}
export function assertGrossReservation(input: GrossReservation) {
  if (
    typeof input.baseDelta !== "bigint" ||
    typeof input.makerDebit !== "bigint" ||
    input.makerDebit < 0n ||
    typeof input.reduceOnly !== "boolean" ||
    !Number.isSafeInteger(input.deadline * 1000) ||
    input.deadline < 0 ||
    !input.baseDelta ||
    !Number.isInteger(input.market) ||
    input.market < 0 ||
    input.market >= MAX_MARKETS
  )
    throw new Error("invalid gross reservation");
}
/** Signatures retain capacity through inclusion; only finalized expiry releases it. */
export class GrossReservationBook {
  private items = new Map<string, GrossReservation>();
  private expiry = new ExpiryIndex();
  /** Reserved gross base per market index; grows as markets are reserved. */
  private totals: Array<{ longBase: bigint; shortBase: bigint }> = [];
  private totalMakerDebit = 0n;
  finalizedBlock = -1;
  finalizedTimestamp = 0;
  finalizedHash?: string;
  get size() {
    return this.items.size;
  }
  get(id: string) {
    return this.items.get(id);
  }
  reserve(id: string, input: GrossReservation) {
    assertGrossReservation(input);
    const old = this.items.get(id);
    if (
      old &&
      (old.market !== input.market ||
        old.baseDelta !== input.baseDelta ||
        old.reduceOnly !== input.reduceOnly ||
        old.makerDebit !== input.makerDebit)
    )
      throw new Error("gross reservation input mismatch");
    const item = { ...input, deadline: Math.max(old?.deadline ?? 0, input.deadline) };
    if (!old) {
      this.items.set(id, item);
      this.adjust(item, 1n);
    } else this.items.set(id, item);
    if (!old || item.deadline !== old.deadline) this.expiry.schedule(id, item.deadline * 1000);
  }
  finalize(
    block: number,
    timestamp: number,
    limit = 512,
    hash?: string,
    beforeRelease?: (ids: string[], finalizedHash?: string) => void,
  ) {
    if (
      !Number.isSafeInteger(block) ||
      !Number.isSafeInteger(timestamp) ||
      block < this.finalizedBlock ||
      timestamp < this.finalizedTimestamp
    )
      throw new Error("finalized clock regression");
    if (
      block === this.finalizedBlock &&
      (timestamp !== this.finalizedTimestamp ||
        (hash && this.finalizedHash && hash.toLowerCase() !== this.finalizedHash.toLowerCase()))
    )
      throw new Error("conflicting finalized header");
    const finalizedHash = hash ?? (block === this.finalizedBlock ? this.finalizedHash : undefined),
      expired = this.expiry.takeExpired(timestamp * 1000 - 1, limit);
    try {
      beforeRelease?.(expired, finalizedHash);
    } catch (error) {
      for (const id of expired) {
        const item = this.items.get(id);
        if (item) this.expiry.schedule(id, item.deadline * 1000);
      }
      throw error;
    }
    this.finalizedHash = finalizedHash;
    this.finalizedBlock = block;
    this.finalizedTimestamp = timestamp;
    for (const id of expired) {
      const item = this.items.get(id)!;
      this.adjust(item, -1n);
      this.items.delete(id);
    }
    return expired;
  }
  /** Reserved gross base per market index, for at least `count` markets (zero-filled). */
  bounds(exclude?: string, count = marketRegistry.count) {
    const result = Array.from({ length: Math.max(count, this.totals.length) }, (_, market) => ({
      longBase: this.totals[market]?.longBase ?? 0n,
      shortBase: this.totals[market]?.shortBase ?? 0n,
    }));
    const old = exclude ? this.items.get(exclude) : undefined;
    if (old && !old.reduceOnly) {
      const side = old.baseDelta > 0n ? "longBase" : "shortBase";
      result[old.market][side] -= abs(old.baseDelta);
    }
    return result;
  }
  capitalDebit(exclude?: string) {
    const old = exclude ? this.items.get(exclude) : undefined;
    return this.totalMakerDebit - (old?.makerDebit ?? 0n);
  }
  admit(
    id: string,
    item: GrossReservation,
    /** Every registered market's exposure book and ask, by index. */
    books: readonly ExposureBook[],
    asks: readonly bigint[],
    blockNumber: number,
    risk?: GrossRiskContext,
  ) {
    assertGrossReservation(item);
    if (blockNumber < this.finalizedBlock) return false;
    if (books.length !== asks.length || item.market >= books.length) return false;
    if (risk && (risk.net.length !== books.length || risk.netLimits.length !== books.length)) return false;
    if (!books.every((book) => book.ready)) return false;
    const old = this.items.get(id);
    if (
      old &&
      (old.market !== item.market || old.baseDelta !== item.baseDelta || old.reduceOnly !== item.reduceOnly)
    )
      return false;
    // The on-chain reduceOnly invariant guarantees zero additional gross capacity.
    if (item.reduceOnly) return true;
    const totals = this.bounds(id, books.length),
      side = item.baseDelta > 0n ? "longBase" : "shortBase";
    totals[item.market][side] += abs(item.baseDelta);
    for (let market = 0; market < books.length; market++) {
      const book = books[market],
        long = book.longBase + totals[market].longBase,
        short = book.shortBase + totals[market].shortBase,
        ask = asks[market];
      if (
        (long + short > 0n && ask <= 0n) ||
        ((long + short) * ask) / BASE > low128(book.limits) ||
        (long * ask) / BASE > high128(book.limits) ||
        (short * ask) / BASE > high128(book.limits)
      )
        return false;
    }
    if (risk) {
      const available = risk.backing - this.capitalDebit(id) - item.makerDebit;
      if (available < risk.floor) return false;
      const low = [...risk.net],
        high = [...risk.net];
      let stress = 0n;
      for (let market = 0; market < books.length; market++) {
        low[market] -= (totals[market].shortBase * asks[market]) / BASE;
        high[market] += (totals[market].longBase * asks[market]) / BASE;
        const cap = high128(risk.netLimits[market]);
        if (abs(low[market]) > cap || abs(high[market]) > cap) return false;
        // Stress is a sum of per-market terms, so the worst execution subset takes each market's worse extreme.
        const lowStress = marketStress(low[market], market),
          highStress = marketStress(high[market], market);
        stress += lowStress > highStress ? lowStress : highStress;
      }
      if (stress > available / 4n) return false;
    }
    return true;
  }
  private adjust(item: GrossReservation, sign: bigint) {
    this.totalMakerDebit += item.makerDebit * sign;
    if (item.reduceOnly) return;
    const side = item.baseDelta > 0n ? "longBase" : "shortBase";
    while (this.totals.length <= item.market) this.totals.push({ longBase: 0n, shortBase: 0n });
    this.totals[item.market][side] += abs(item.baseDelta) * sign;
  }
}
