/** Builders for approver unit tests. Not loaded by production code. */
import { Interface, Wallet, getAddress, keccak256, toBeHex, type BaseWallet, type BlockTag } from "ethers";
import type { ApproverPayload } from "../../../packages/shared/src/approver-payload.js";
import type { ClearingSessionStruct } from "../../../packages/shared/src/clearing-structs.js";
import {
  DOMAIN_NAME,
  DOMAIN_VERSION,
  approvalToWire,
  intentDigest,
  intentToWire,
  triggerToWire,
  type MakerApproval,
  type SigningDomain,
  type TradeIntent,
  type Trigger,
} from "../../../packages/shared/src/eip712.js";
import {
  encodeMarketSymbol,
  marketIndex,
  marketRegistry,
  type Market,
} from "../../../packages/shared/src/markets.js";
import { encodeLocalReport, oracleAdapterAbi } from "../../../packages/shared/src/oracle-report.js";
import { adaptiveSpread, constructQuote, launchPricing } from "../../../packages/shared/src/pricing.js";
import { quoteToWire } from "../../../packages/shared/src/wire.js";
import type { ChainClients, ClearingReader } from "./chain-state.js";

export const CHAIN_ID = 31_337n;
export const CLEARING = "0x00000000000000000000000000000000000000c1";
export const PRICES: Record<Market, bigint> = { BTC: 100_000_000_000n, ETH: 4_000_000_000n };
/** Packs (low, high) into one limit word. */
export const word = (low: bigint, high = low) => low | (high << 128n);
export const LARGE = 1_000_000_000_000_000n;

export interface PayloadOptions {
  nowMs?: number;
  market?: Market;
  side?: "buy" | "sell";
  amount?: string;
  user?: BaseWallet;
  /** Defaults to the adaptive-v1 spread; false omits the spread breakdown. */
  spread?: boolean;
  /** Overrides for the local oracle report observation. */
  report?: Partial<{ bid: bigint; ask: bigint; observedAt: bigint; validUntil: bigint; market: number }>;
  /** Sign a `TriggeredTradeIntent` with this trigger and send it in the payload. */
  trigger?: Trigger;
  /** The signed intent's size when it differs from the quoted fill (a clamped reduce-only trigger). */
  signedBaseDelta?: bigint;
  reduceOnly?: boolean;
}

export interface Fixture {
  payload: ApproverPayload;
  domain: SigningDomain;
  intent: TradeIntent;
  approval: MakerApproval;
  user: BaseWallet;
  nowMs: number;
}

/** A consistent, signed leader envelope priced like the leader would price it. */
export function buildFixture(options: PayloadOptions = {}): Fixture {
  const nowMs = options.nowMs ?? Date.now(),
    nowSeconds = BigInt(Math.floor(nowMs / 1000)),
    market = options.market ?? "BTC",
    side = options.side ?? "buy",
    user = options.user ?? Wallet.createRandom(),
    price = PRICES[market];
  const quote = constructQuote(
    { market, side, amount: options.amount ?? "1000" },
    { market, bid: price, ask: price, observedAtMs: nowMs },
    { BTC: 0n, ETH: 0n },
    [],
    nowMs,
    crypto.randomUUID(),
    {
      ...launchPricing,
      maxNotional: 10n ** 15n,
      spread: options.spread === false ? undefined : adaptiveSpread(),
    },
  );
  const report = encodeLocalReport({
    market: marketIndex(market),
    bid: price,
    ask: price,
    observedAt: nowSeconds,
    validUntil: nowSeconds + 60n,
    ...options.report,
  });
  const domain: SigningDomain = {
    name: DOMAIN_NAME,
    version: DOMAIN_VERSION,
    chainId: CHAIN_ID,
    verifyingContract: getAddress(CLEARING),
  };
  const intent: TradeIntent = {
    account: user.address,
    market: marketIndex(market),
    baseDelta: options.signedBaseDelta ?? quote.baseDelta,
    limitPrice: quote.worstPrice,
    maxFee: options.signedBaseDelta === undefined ? quote.fee : quote.fee * 4n,
    nonce: 7n,
    deadline: nowSeconds + 30n,
    reduceOnly: options.reduceOnly ?? false,
  };
  const intentHash = intentDigest(domain, intent, options.trigger);
  const approval: MakerApproval = {
    intentHash,
    executionPrice: quote.expectedPrice,
    impactCharge: quote.impactCharge,
    fee: quote.fee,
    oracleReportHash: keccak256(report),
    deadline: nowSeconds + 30n,
    leaderEpoch: 1n,
    signerSetVersion: 1n,
    policyVersion: 1n,
  };
  const userSignature = user.signingKey.sign(intentHash).serialized;
  const payload: ApproverPayload = {
    domain: { ...domain, chainId: domain.chainId.toString() },
    intent: intentToWire(intent),
    ...(options.trigger ? { trigger: triggerToWire(options.trigger) } : {}),
    userSignature,
    approval: approvalToWire(approval),
    quote: quoteToWire(quote),
    report,
    oracleAgeMs: 0,
  };
  return { payload, domain, intent, approval, user, nowMs };
}

export interface FakeChainState {
  chainId: bigint;
  secondaryChainId?: bigint;
  blockNumber: number;
  blockTimestamp: number;
  blockHash: string;
  secondaryBlockHash?: string;
  missingBlock?: boolean;
  leaderEpoch: bigint;
  signerSetVersion: bigint;
  policyVersion: bigint;
  paused: boolean;
  resolutionRequired: boolean;
  isApprover: boolean;
  /** One entry per registered market (the launch fixture has BTC and ETH). */
  markets: Array<Record<string, bigint | boolean>>;
  books: Array<Record<string, bigint | boolean>>;
  limitWords: bigint[];
  position: { size: bigint; entryPrice: bigint; lastFundingIndex: bigint };
  sessions: Record<string, ClearingSessionStruct>;
  erc1271: boolean;
  backing: bigint;
  floor: bigint;
  oracle: string;
  /** Observations returned by the fake signed adapter's `verify`. */
  signedObservations?: { market: bigint; bid: bigint; ask: bigint; observedAt: bigint; validUntil: bigint }[];
  /** Any read listed here throws. */
  failing?: string[];
}

/** Healthy chain state at `nowMs` that admits a fixture trade. */
export function chainState(nowMs: number): FakeChainState {
  const timestamp = Math.floor(nowMs / 1000),
    market = (price: bigint) => ({
      aggregateBase: 0n,
      fundingIndex: 0n,
      fundingTime: BigInt(timestamp),
      lastPriceTime: BigInt(timestamp),
      lastBid: price,
      lastAsk: price,
      enabled: true,
    }),
    book = () => ({ longBase: 0n, shortBase: 0n, limits: word(LARGE), cursor: 0n, ready: true });
  return {
    chainId: CHAIN_ID,
    blockNumber: 100,
    blockTimestamp: timestamp,
    blockHash: `0x${"ab".repeat(32)}`,
    leaderEpoch: 1n,
    signerSetVersion: 1n,
    policyVersion: 1n,
    paused: false,
    resolutionRequired: false,
    isApprover: true,
    markets: [market(PRICES.BTC), market(PRICES.ETH)],
    books: [book(), book()],
    limitWords: [word(LARGE), word(LARGE)],
    position: { size: 0n, entryPrice: 0n, lastFundingIndex: 0n },
    sessions: {},
    erc1271: false,
    backing: LARGE,
    floor: 0n,
    oracle: "0x00000000000000000000000000000000000000a1",
  };
}

/** In-memory `ChainClients` serving `state`; records RPC methods called. */
export function fakeChain(state: FakeChainState): ChainClients & { calls: string[] } {
  const calls: string[] = [];
  const read = async <T>(name: string, value: () => T): Promise<T> => {
    calls.push(name);
    if (state.failing?.includes(name)) throw new Error(`${name} unavailable`);
    return value();
  };
  const adapter = new Interface(oracleAdapterAbi);
  const block = (hash: string) => (state.missingBlock ? null : { timestamp: state.blockTimestamp, hash });
  const provider = (secondary: boolean) =>
    ({
      getNetwork: () =>
        read("getNetwork", () => ({
          chainId: secondary ? (state.secondaryChainId ?? state.chainId) : state.chainId,
        })),
      getBlock: () =>
        read("getBlock", () =>
          block(secondary ? (state.secondaryBlockHash ?? state.blockHash) : state.blockHash),
        ),
      send: (method: string, params: Array<{ data: string }>) =>
        read(method, () => {
          if (method === "eth_blockNumber") return toBeHex(state.blockNumber);
          if (method === "eth_getBlockByNumber") return null;
          if (method === "eth_call") {
            const call = adapter.parseTransaction({ data: params[0].data })!;
            if (call.name === "updateFee") return adapter.encodeFunctionResult("updateFee", [1n]);
            return adapter.encodeFunctionResult("verify", [state.signedObservations ?? []]);
          }
          throw new Error(`unexpected ${method}`);
        }),
    }) as unknown as ChainClients["provider"];
  type At = { blockTag: BlockTag };
  const clearing: ClearingReader = {
    leaderEpoch: (_: At) => read("leaderEpoch", () => state.leaderEpoch),
    signerSetVersion: (_: At) => read("signerSetVersion", () => state.signerSetVersion),
    policyVersion: (_: At) => read("policyVersion", () => state.policyVersion),
    paused: (_: At) => read("paused", () => state.paused),
    resolutionRequired: (_: At) => read("resolutionRequired", () => state.resolutionRequired),
    isApprover: (_account: string, _: At) => read("isApprover", () => state.isApprover),
    marketCount: () => read("marketCount", () => BigInt(state.markets.length)),
    marketParams: (index: number) =>
      read("marketParams", () => {
        const market = marketRegistry.at(index);
        return {
          symbol: encodeMarketSymbol(market.symbol),
          impactK: market.impactK,
          shockBps: market.shockBps,
          marginScaleBps: BigInt(market.marginScaleBps),
        };
      }),
    markets: (index: number) => read("markets", () => state.markets[index] as never),
    marketLimitWord: (index: number) => read("marketLimitWord", () => state.limitWords[index]),
    exposureState: (index: number) => read("exposureState", () => state.books[index] as never),
    positionOf: () => read("positionOf", () => state.position),
    sessions: (signer: string) => read("sessions", () => state.sessions[signer]),
    makerBacking: () => read("makerBacking", () => state.backing),
    baseRiskCapitalTarget: () => read("baseRiskCapitalTarget", () => state.floor),
    oracle: () => read("oracle", () => state.oracle),
  };
  return {
    calls,
    provider: provider(false),
    secondaryProvider: provider(true),
    clearing,
    isValidSignature: () => read("isValidSignature", () => state.erc1271),
  };
}
