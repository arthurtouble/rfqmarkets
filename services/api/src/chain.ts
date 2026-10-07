import { AbiCoder, Contract, type Block } from "ethers";
import { DEFAULT_MARGIN_SCALE_BPS } from "../../../packages/shared/src/pricing.js";
import type { ApiContext } from "./context.js";
import { MARKETS, unixSeconds, type Market } from "./markets.js";
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
  markets: [ChainMarketState, ChainMarketState];
  limitWords: [bigint, bigint];
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

  constructor(private readonly ctx: ApiContext) {}

  invalidateQuoteSnapshot() {
    this.quoteSnapshotCache = undefined;
  }

  async blockNumber() {
    return Number(BigInt(await this.ctx.provider!.send("eth_blockNumber", [])));
  }

  /**
   * Per-market margin multipliers (`marketParams(id).marginScaleBps`), cached briefly. Without a chain
   * the base tiers (10_000) apply. Governance changes to them also bump the policy version.
   */
  async marginScales(blockTag?: number): Promise<Record<Market, number>> {
    const { clearing } = this.ctx;
    if (!clearing) return { BTC: DEFAULT_MARGIN_SCALE_BPS, ETH: DEFAULT_MARGIN_SCALE_BPS };
    const now = Date.now();
    if (
      blockTag === undefined &&
      this.marginScaleCache &&
      now - this.marginScaleCache.at < MARGIN_SCALE_CACHE_MS
    )
      return this.marginScaleCache.promise;
    const at = blockTag === undefined ? {} : { blockTag };
    const promise = Promise.all(MARKETS.map((_, index) => clearing.marketParams(index, at))).then(
      (params) =>
        Object.fromEntries(
          MARKETS.map((market, index) => [market, Number(params[index].marginScaleBps)]),
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

  /** Latest block time through `eth_getBlockByNumber`; falls back to wall time without a chain. */
  async chainTimestamp() {
    const { provider } = this.ctx;
    if (!provider) return unixSeconds();
    const block = await provider.getBlock("latest");
    if (!block) throw new Error("latest block unavailable");
    return block.timestamp;
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
    const blockNumber = await this.blockNumber(),
      blockTag = { blockTag: blockNumber };
    const [block, leaderEpoch, signerSetVersion, policyVersion, paused, resolutionRequired] =
      await Promise.all([
        provider.getBlock(blockNumber),
        clearing.leaderEpoch(blockTag),
        clearing.signerSetVersion(blockTag),
        clearing.policyVersion(blockTag),
        clearing.paused(blockTag),
        clearing.resolutionRequired(blockTag),
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
      const [
        block,
        btc,
        eth,
        btcLimits,
        ethLimits,
        leaderEpoch,
        signerSetVersion,
        policyVersion,
        paused,
        resolutionRequired,
      ] = await Promise.all([
        provider.getBlock(blockNumber),
        clearing.markets(0, blockTag),
        clearing.markets(1, blockTag),
        clearing.marketLimitWord(0, blockTag),
        clearing.marketLimitWord(1, blockTag),
        clearing.leaderEpoch(blockTag),
        clearing.signerSetVersion(blockTag),
        clearing.policyVersion(blockTag),
        clearing.paused(blockTag),
        clearing.resolutionRequired(blockTag),
      ]);
      return {
        blockNumber,
        block,
        markets: [btc, eth],
        limitWords: [btcLimits, ethLimits],
        leaderEpoch,
        signerSetVersion,
        policyVersion,
        paused,
        resolutionRequired,
      };
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
