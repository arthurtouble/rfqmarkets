import { Contract, Interface, JsonRpcProvider, getAddress, toBeHex, toQuantity, type BlockTag } from "ethers";
import { clearingApproverAbi, sessionGrantedFilter } from "../../../packages/shared/src/abi.js";
import {
  toExposureBook,
  toExposureMarket,
  toPosition,
  toSession,
  toLimitWord,
  type ClearingBookStruct,
  type ClearingLimitsStruct,
  type ClearingMarketStruct,
  type ClearingPositionStruct,
  type ClearingSessionStruct,
  type SessionState,
} from "../../../packages/shared/src/clearing-structs.js";
import type { MakerApproval, TradeIntent } from "../../../packages/shared/src/eip712.js";
import type {
  ExposureBook,
  ExposureMarket,
  PositionState,
} from "../../../packages/shared/src/exposure-admission.js";
import { marketRegistry, type MarketIndex } from "../../../packages/shared/src/markets.js";
import {
  oracleAdapterAbi,
  toOracleObservation,
  type OracleObservationInput,
  type OracleObservation,
} from "../../../packages/shared/src/oracle-report.js";
import { reject, type Rejection } from "./rejection.js";

type At = { blockTag: BlockTag };

/** The RFQClearing views an approver reads, pinned to one block. */
export interface ClearingReader {
  leaderEpoch(at: At): Promise<bigint>;
  signerSetVersion(at: At): Promise<bigint>;
  policyVersion(at: At): Promise<bigint>;
  paused(at: At): Promise<boolean>;
  resolutionRequired(at: At): Promise<boolean>;
  isApprover(account: string, at: At): Promise<boolean>;
  marketCount(at?: At): Promise<bigint>;
  marketParams(
    market: number,
    at?: At,
  ): Promise<{ symbol: string; impactK: bigint; shockBps: bigint; marginScaleBps: bigint }>;
  markets(market: number, at?: At): Promise<ClearingMarketStruct>;
  marketLimits(market: number, at: At): Promise<ClearingLimitsStruct>;
  exposure(market: number, at: At): Promise<ClearingBookStruct>;
  positionOf(account: string, market: number, at: At): Promise<ClearingPositionStruct>;
  sessions(signer: string, at: At): Promise<ClearingSessionStruct>;
  /** Owner and market of an isolated account; a zero owner for an ordinary account. */
  isolatedOwner(account: string, at: At): Promise<{ owner: string; market: bigint | number }>;
  makerBacking(at: At): Promise<bigint>;
  baseRiskCapitalTarget(at: At): Promise<bigint>;
  oracle(at: At): Promise<string>;
}
export type ChainProvider = Pick<JsonRpcProvider, "getNetwork" | "getBlock" | "send">;

export interface ChainClients {
  provider: ChainProvider;
  /** Independent provider whose block hash must agree with the primary. */
  secondaryProvider?: ChainProvider;
  clearing: ClearingReader;
  /** ERC-1271 `isValidSignature` at a block; false on revert. */
  isValidSignature(account: string, hash: string, signature: string, blockNumber: number): Promise<boolean>;
  /**
   * The session key `account` granted last in the {@link SESSION_LOOKBACK_BLOCKS} blocks through
   * `toBlock`, or undefined when it granted none.
   */
  latestSession(account: string, toBlock: number): Promise<string | undefined>;
}

/**
 * How far back an approver looks for an account's newest session grant: a little over seven days of Base
 * blocks, longer than the app's week-long keys. A key is honoured only while it is the newest one its
 * account granted in this window, so keys left behind on another device, or granted long ago, stop signing trades.
 */
export const SESSION_LOOKBACK_BLOCKS = 310_000;
/** Blocks per `eth_getLogs` call: the smallest cap among the free RPCs the dev runtime uses. */
const GRANT_LOG_CHUNK = 1_000;
/** `eth_getLogs` calls in flight at once while scanning back, so a cold scan of a week stays a few seconds. */
const GRANT_LOG_PARALLEL = 16;
/** Accounts whose newest grant is remembered; past this the memory starts over. */
const GRANT_CACHE_ACCOUNTS = 10_000;

type GrantLog = { session: string; block: number };

/**
 * `latestSession` over a log reader. Scans newest blocks first in {@link GRANT_LOG_CHUNK} ranges,
 * {@link GRANT_LOG_PARALLEL} at a time, and stops at the first wave with a grant, and remembers each account's newest grant and how far it has scanned, so a
 * key in steady use costs one small range per check.
 */
export function sessionGrantTracker(
  grantsOf: (account: string, fromBlock: number, toBlock: number) => Promise<GrantLog[]>,
): ChainClients["latestSession"] {
  const known = new Map<string, { grant?: GrantLog; through: number }>();
  return async (account, toBlock) => {
    const floor = Math.max(0, toBlock - SESSION_LOOKBACK_BLOCKS),
      cached = known.get(account),
      usable = cached && cached.through >= floor && cached.through <= toBlock ? cached : undefined;
    let found: GrantLog | undefined;
    for (let end = toBlock, from = usable ? usable.through + 1 : floor; end >= from && !found;) {
      const ranges: Array<[number, number]> = [];
      for (; end >= from && ranges.length < GRANT_LOG_PARALLEL; end -= GRANT_LOG_CHUNK)
        ranges.push([Math.max(from, end - GRANT_LOG_CHUNK + 1), end]);
      // Newest range first, so the first range with a grant holds the newest one.
      const waves = await Promise.all(ranges.map(([start, stop]) => grantsOf(account, start, stop)));
      found = waves.find((logs) => logs.length > 0)?.at(-1);
    }
    const grant = found ?? (usable?.grant && usable.grant.block >= floor ? usable.grant : undefined);
    if (known.size >= GRANT_CACHE_ACCOUNTS && !known.has(account)) known.clear();
    known.set(account, { grant, through: toBlock });
    return grant?.session;
  };
}

const ERC1271_MAGIC_VALUE = "0x1626ba7e";

export function createChainClients(
  provider: JsonRpcProvider,
  secondaryProvider: JsonRpcProvider | undefined,
  clearingAddress: string,
): ChainClients {
  const clearing = new Contract(clearingAddress, clearingApproverAbi, provider);
  return {
    provider,
    secondaryProvider,
    clearing: clearing as unknown as ClearingReader,
    latestSession: sessionGrantTracker(async (account, fromBlock, toBlock) => {
      const logs = await clearing.queryFilter(sessionGrantedFilter(account), fromBlock, toBlock);
      return logs.flatMap((log) => {
        const parsed = clearing.interface.parseLog(log);
        return parsed ? [{ session: getAddress(parsed.args.session as string), block: log.blockNumber }] : [];
      });
    }),
    isValidSignature: (account, hash, signature, blockNumber) =>
      new Contract(account, ["function isValidSignature(bytes32,bytes) view returns(bytes4)"], provider)
        .isValidSignature(hash, signature, { blockTag: blockNumber })
        .then((value: string) => value.toLowerCase() === ERC1271_MAGIC_VALUE)
        .catch(() => false),
  };
}

/** Clearing state at one block, as read by this approver's own RPC. */
export interface ChainSnapshot {
  blockNumber: number;
  blockTimestamp: number;
  leaderEpoch: bigint;
  signerSetVersion: bigint;
  policyVersion: bigint;
  paused: boolean;
  resolutionRequired: boolean;
  /** This approver is a member of the on-chain signer set. */
  isApprover: boolean;
  /** Every registered market at this block, by index. */
  markets: ExposureMarket[];
  books: ExposureBook[];
  /** `marketLimits` per market index, packed by `toLimitWord`. */
  limitWords: bigint[];
  /** The intent account's position in the intent market. */
  position: PositionState;
  backing: bigint;
  floor: bigint;
  /** The address that signs for the intent account: its owner when the account is isolated. */
  signingAccount: string;
  /** EOA signature by the signing account, or a valid ERC-1271 signature from it. */
  accountSignatureValid: boolean;
  /** Session of a non-account ECDSA signer. */
  session?: SessionState;
  /** That signer is the newest session key its account granted recently (see `SESSION_LOOKBACK_BLOCKS`). */
  sessionIsLatest: boolean;
}

/**
 * Each approver's last `isApprover` answer, valid while the on-chain signer set keeps the version it was
 * read at: any change to the set bumps `signerSetVersion`, so a removed approver is re-read at once.
 */
const enrolment = new WeakMap<ChainClients, { signer: string; version: bigint; value: boolean }>();

/**
 * Read everything the chain checks need at one block. Rejects when either RPC
 * reports another chain, when the secondary RPC disagrees on the block hash,
 * or when the block is unavailable. Read failures throw.
 */
export async function readChainState(
  chain: ChainClients,
  request: {
    chainId: bigint;
    signer: string;
    intent: TradeIntent;
    intentHash: string;
    intentSigner: string | undefined;
    userSignature: string;
  },
): Promise<{ snapshot: ChainSnapshot } | { rejection: Rejection }> {
  const { provider, secondaryProvider, clearing } = chain,
    { intent, intentSigner } = request,
    market = intent.market as MarketIndex;
  const [network, secondaryNetwork] = await Promise.all([
    provider.getNetwork(),
    secondaryProvider?.getNetwork(),
  ]);
  if (
    network.chainId !== request.chainId ||
    (secondaryNetwork && secondaryNetwork.chainId !== request.chainId)
  )
    return { rejection: reject("rpc chain mismatch") };
  const blockNumber = Number(BigInt(await provider.send("eth_blockNumber", [])));
  const at = { blockTag: blockNumber };
  // Risk is checked over every market the chain has at this block; a registry that lags the chain is
  // refreshed first, and the intent's market must exist.
  const marketCount = Number(await clearing.marketCount(at));
  if (market >= marketCount) return { rejection: reject("unknown market") };
  try {
    await marketRegistry.ensureCount(marketCount);
  } catch {
    return { rejection: reject("market registry unavailable", 503) };
  }
  const indexes = Array.from({ length: marketCount }, (_, index) => index);
  // An isolated account's intents are signed by its owner, directly or through the owner's session key.
  const isolated = await clearing.isolatedOwner(intent.account, at),
    signingAccount = BigInt(isolated.owner) === 0n ? intent.account : getAddress(isolated.owner);
  const signedByAccount = intentSigner === signingAccount;
  const [
    block,
    secondaryBlock,
    leaderEpoch,
    signerSetVersion,
    policyVersion,
    paused,
    resolutionRequired,
    cachedEnrolment,
    rawMarkets,
    limitWords,
    accountSignatureValid,
    session,
    latestSession,
    position,
    rawBooks,
    backing,
    floor,
  ] = await Promise.all([
    provider.getBlock(blockNumber),
    secondaryProvider?.getBlock(blockNumber),
    clearing.leaderEpoch(at),
    clearing.signerSetVersion(at),
    clearing.policyVersion(at),
    clearing.paused(at),
    clearing.resolutionRequired(at),
    enrolment.get(chain),
    Promise.all(indexes.map((index) => clearing.markets(index, at))),
    Promise.all(indexes.map(async (index) => toLimitWord(await clearing.marketLimits(index, at)))),
    signedByAccount
      ? Promise.resolve(true)
      : chain.isValidSignature(signingAccount, request.intentHash, request.userSignature, blockNumber),
    signedByAccount || intentSigner === undefined
      ? Promise.resolve(undefined)
      : clearing.sessions(intentSigner, at),
    signedByAccount || intentSigner === undefined
      ? Promise.resolve(undefined)
      : chain.latestSession(signingAccount, blockNumber),
    clearing.positionOf(intent.account, market, at),
    Promise.all(indexes.map((index) => clearing.exposure(index, at))),
    clearing.makerBacking(at),
    clearing.baseRiskCapitalTarget(at),
  ]);
  if (secondaryProvider && (!secondaryBlock || secondaryBlock.hash !== block?.hash))
    return { rejection: reject("rpc divergence") };
  if (!block) return { rejection: reject("independent chain policy rejected") };
  let isApprover = cachedEnrolment?.value;
  if (
    isApprover === undefined ||
    cachedEnrolment!.signer !== request.signer ||
    cachedEnrolment!.version !== BigInt(signerSetVersion)
  ) {
    isApprover = Boolean(await clearing.isApprover(request.signer, at));
    enrolment.set(chain, { signer: request.signer, version: BigInt(signerSetVersion), value: isApprover });
  }
  return {
    snapshot: {
      blockNumber,
      blockTimestamp: block.timestamp,
      leaderEpoch: BigInt(leaderEpoch),
      signerSetVersion: BigInt(signerSetVersion),
      policyVersion: BigInt(policyVersion),
      paused: Boolean(paused),
      resolutionRequired: Boolean(resolutionRequired),
      isApprover: Boolean(isApprover),
      markets: rawMarkets.map(toExposureMarket),
      books: rawBooks.map(toExposureBook),
      limitWords,
      position: toPosition(position),
      backing: BigInt(backing),
      floor: BigInt(floor),
      signingAccount,
      accountSignatureValid: Boolean(accountSignatureValid),
      session: session && toSession(session),
      sessionIsLatest: latestSession !== undefined && latestSession === intentSigner,
    },
  };
}

/** The leader's versions must be the chain's, and the venue must be open with this signer enrolled. */
export function checkChainPolicy(snapshot: ChainSnapshot, approval: MakerApproval): Rejection | undefined {
  if (
    snapshot.leaderEpoch !== approval.leaderEpoch ||
    snapshot.signerSetVersion !== approval.signerSetVersion ||
    snapshot.policyVersion !== approval.policyVersion ||
    snapshot.paused ||
    snapshot.resolutionRequired ||
    !snapshot.isApprover
  )
    return reject("independent chain policy rejected");
}

/**
 * Dry-run the oracle adapter's `verify` from the clearing contract at the read
 * block, paying its quoted update fee, and return the observation it would
 * settle `market` against. Throws when consensus left the market out.
 */
export async function verifySignedReport(
  chain: ChainClients,
  report: string,
  clearingAddress: string,
  blockNumber: number,
  market: number,
): Promise<OracleObservation> {
  const adapter = new Interface(oracleAdapterAbi),
    oracleAddress = await chain.clearing.oracle({ blockTag: blockNumber }),
    [fee] = adapter.decodeFunctionResult(
      "updateFee",
      await chain.provider.send("eth_call", [
        { to: oracleAddress, data: adapter.encodeFunctionData("updateFee", [report]) },
        toQuantity(blockNumber),
      ]),
    );
  const raw = await chain.provider.send("eth_call", [
      {
        to: oracleAddress,
        from: clearingAddress,
        data: adapter.encodeFunctionData("verify", [report]),
        value: toBeHex(fee),
      },
      toBeHex(blockNumber),
    ]),
    [values] = adapter.decodeFunctionResult("verify", raw),
    observation = Array.from(values as OracleObservationInput[], toOracleObservation).find(
      (item) => item.market === BigInt(market),
    );
  if (!observation) throw new Error("oracle consensus omitted the market");
  return observation;
}
