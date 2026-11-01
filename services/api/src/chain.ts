import { toLimitWord } from "../../../packages/shared/src/clearing-structs.js";
import { AbiCoder, Contract, type Block } from "ethers";
import { DEFAULT_MARGIN_SCALE_BPS } from "../../../packages/shared/src/pricing.js";
import { readViews, type ViewCall } from "../../../packages/shared/src/rpc.js";
import type { ApiContext } from "./context.js";
import { marketRegistry, unixSeconds, type Market } from "./markets.js";
import type { ProtocolVersions } from "./quote-store.js";

const LOCAL_REPORT_TYPE = "tuple(uint8 market,uint256 bid,uint256 ask,uint64 observedAt,uint64 validUntil)[]";
const ORACLE_ADAPTER_ABI = ["function updateFee(bytes) view returns(uint256)"];
const LIMIT_MASK = (1n << 128n) - 1n;
const MARGIN_SCALE_CACHE_MS = 5_000;

/** Encode the local development oracle report accepted by the mock adapter: a one-market batch. */
export function encodeLocalReport(
  market: number,
  bid: bigint,
  ask: bigint,
  observedAt: number | bigint,
  validUntil: number | bigint,
) {
  return AbiCoder.defaultAbiCoder().encode(
    [LOCAL_REPORT_TYPE],
    [[[market, bid, ask, BigInt(observedAt), BigInt(validUntil)]]],
  );
}

/** The clearing contract packs the per-trade limit into the low and the market limit into the high 128 bits. */
export function decodeLimits(word: unknown) {
  const value = BigInt(word as bigint);
  return { maxTradeNotional: value & LIMIT_MASK, maxMarketNotional: value >> 128n };
}

/** Raw clearing market struct as returned by `markets(uint8)`. */
export type ChainMarketState = {
  aggregateBase: bigint;
  fundingIndex: bigint;
  fundingTime: bigint;
  lastPriceTime: bigint;
  lastBid: bigint;
  lastAsk: bigint;
  enabled: boolean;
};

export type QuoteSnapshot = {
  blockNumber: number;
  block: Block | null;
  /** Every registered market at this block, by index. */
  markets: ChainMarketState[];
  limitWords: bigint[];
  /** Every registered market's exposure book (`exposure(index)`) at this block, by index. */
  books: unknown[];
  leaderEpoch: bigint;
  signerSetVersion: bigint;
  policyVersion: bigint;
  paused: boolean;
  resolutionRequired: boolean;
};

/** Chain reads shared by quoting, execution and signed actions. */
export class ChainReader {
  private quoteSnapshotCache:
    { at: number; blockNumber: number; promise: Promise<QuoteSnapshot> } | undefined;
  private marginScaleCache: { at: number; promise: Promise<Record<Market, number>> } | undefined;
  private blockNumberInFlight: Promise<number> | undefined;
  private blockCache: { number: number; promise: Promise<Block | null> } | undefined;

  constructor(private readonly ctx: ApiContext) {}

  invalidateQuoteSnapshot() {
    this.quoteSnapshotCache = undefined;
  }

  /**
   * The head block number. Concurrent callers share one in-flight request (a trade's quote, admission and
   * approval asked at once, in bursts a rate-limited RPC refused); an answer is never reused once it has
   * arrived, so a governance change or a margin move that just landed is always seen.
   */
  async blockNumber() {
    if (this.blockNumberInFlight) return this.blockNumberInFlight;
    const promise = this.ctx
      .provider!.send("eth_blockNumber", [])
      .then((value: string) => Number(BigInt(value)))
      .finally(() => {
        if (this.blockNumberInFlight === promise) this.blockNumberInFlight = undefined;
      });
    this.blockNumberInFlight = promise;
    return promise;
  }

  /** A block header by number, reused while it is the latest one asked for. */
  async block(blockNumber: number) {
    if (this.blockCache?.number === blockNumber) return this.blockCache.promise;
    const promise = this.ctx.provider!.getBlock(blockNumber);
    this.blockCache = { number: blockNumber, promise };
    promise.then(
      (block) => {
        if (!block && this.blockCache?.promise === promise) this.blockCache = undefined;
      },
      () => {
        if (this.blockCache?.promise === promise) this.blockCache = undefined;
      },
    );
    return promise;
  }

  /**
   * Per-market margin multipliers (`marketParams(id).marginScaleBps`), cached briefly. Without a chain
   * the base tiers (10_000) apply. Governance changes to them also bump the policy version.
   */
  async marginScales(blockTag?: number): Promise<Record<Market, number>> {
    const { clearing } = this.ctx;
    if (!clearing) return marketRegistry.record(() => DEFAULT_MARGIN_SCALE_BPS);
    const now = Date.now();
    if (
      blockTag === undefined &&
      this.marginScaleCache &&
      now - this.marginScaleCache.at < MARGIN_SCALE_CACHE_MS
    )
      return this.marginScaleCache.promise;
    const at = blockTag === undefined ? {} : { blockTag };
    const markets = marketRegistry.all();
    const promise = Promise.all(markets.map(({ index }) => clearing.marketParams(index, at))).then(
      (params) =>
        Object.fromEntries(
          markets.map(({ symbol }, index) => [symbol, Number(params[index].marginScaleBps)]),
        ) as Record<Market, number>,
    );
    if (blockTag !== undefined) return promise;
    this.marginScaleCache = { at: now, promise };
    try {
      return await promise;
    } catch (error) {
      this.marginScaleCache = undefined;
      throw error;
    }
  }

  /** Latest block time from a raw `eth_getBlockByNumber`; falls back to wall time without a chain. */
  async chainTimestamp() {
    return this.ctx.provider ? this.latestBlockTimestamp() : unixSeconds();
  }

  /** Latest block time through a raw RPC call, as used for oracle report timestamps. */
  async latestBlockTimestamp() {
    const latest = (await this.ctx.provider!.send("eth_getBlockByNumber", ["latest", false])) as {
      timestamp: string;
    };
    return Number(BigInt(latest.timestamp));
  }

  /** The oracle adapter that prices `refreshOracle` and trade proof verification. */
  async oracleAdapter(blockTag?: number) {
    const { clearing, provider } = this.ctx;
    const address = await (blockTag === undefined ? clearing!.oracle() : clearing!.oracle({ blockTag }));
    return new Contract(address, ORACLE_ADAPTER_ABI, provider);
  }

  async readProtocolVersions(): Promise<ProtocolVersions> {
    const { clearing, provider } = this.ctx;
    if (!clearing || !provider)
      return {
        leaderEpoch: 1n,
        signerSetVersion: 1n,
        policyVersion: 1n,
        blockNumber: 0,
        blockTimestamp: unixSeconds(),
      };
    const blockNumber = await this.blockNumber();
    const [block, [leaderEpoch, signerSetVersion, policyVersion, paused, resolutionRequired]] =
      await Promise.all([
        this.block(blockNumber),
        readViews(
          clearing,
          [["leaderEpoch"], ["signerSetVersion"], ["policyVersion"], ["paused"], ["resolutionRequired"]],
          blockNumber,
        ) as Promise<[bigint, bigint, bigint, boolean, boolean]>,
      ]);
    if (!block || paused || resolutionRequired) throw new Error("market is paused");
    return {
      leaderEpoch: BigInt(leaderEpoch),
      signerSetVersion: BigInt(signerSetVersion),
      policyVersion: BigInt(policyVersion),
      blockNumber,
      blockTimestamp: block.timestamp,
    };
  }

  /** One coherent block-pinned read of everything a firm quote depends on, cached briefly. */
  async readQuoteSnapshot(): Promise<QuoteSnapshot> {
    const { clearing, provider } = this.ctx;
    if (!clearing || !provider) throw new Error("chain unavailable");
    const now = Date.now();
    if (this.quoteSnapshotCache && now - this.quoteSnapshotCache.at < 100)
      return this.quoteSnapshotCache.promise;
    const blockNumber = await this.blockNumber();
    if (
      this.quoteSnapshotCache &&
      this.quoteSnapshotCache.blockNumber === blockNumber &&
      now - this.quoteSnapshotCache.at < 250
    )
      return this.quoteSnapshotCache.promise;
    const blockTag = { blockTag: blockNumber };
    const promise = (async (): Promise<QuoteSnapshot> => {
      // Everything in one Multicall3 call at the block (plus the block header): this read runs for every firm
      // quote on a new block, and as ~17 separate eth_calls it was most of the API's RPC traffic. The market
      // count rides along; when a market has been added since, the read repeats with the new market included.
      const read = async () => {
        const indexes = marketRegistry.all().map((market) => market.index);
        const values = await readViews(
          clearing,
          [
            ["marketCount"],
            ["leaderEpoch"],
            ["signerSetVersion"],
            ["policyVersion"],
            ["paused"],
            ["resolutionRequired"],
            ...indexes.flatMap((index): ViewCall[] => [
              ["markets", index],
              ["marketLimits", index],
              ["exposure", index],
            ]),
          ],
          blockNumber,
        );
        return { indexes, values };
      };
      let [block, { indexes, values }] = await Promise.all([this.block(blockNumber), read()]);
      const count = Number(values[0]);
      if (count !== indexes.length) {
        await marketRegistry.ensureCount(count);
        ({ indexes, values } = await read());
      }
      const [, leaderEpoch, signerSetVersion, policyVersion, paused, resolutionRequired] = values;
      const perMarket = values.slice(6);
      return {
        blockNumber,
        block,
        markets: indexes.map((_, i) => perMarket[i * 3]),
        limitWords: indexes.map((_, i) => toLimitWord(perMarket[i * 3 + 1] as never)),
        books: indexes.map((_, i) => perMarket[i * 3 + 2]),
        leaderEpoch,
        signerSetVersion,
        policyVersion,
        paused,
        resolutionRequired,
      } as QuoteSnapshot;
    })();
    this.quoteSnapshotCache = { at: now, blockNumber, promise };
    try {
      return await promise;
    } catch (error) {
      this.quoteSnapshotCache = undefined;
      throw error;
    }
  }
}
