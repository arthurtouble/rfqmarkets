import { Contract, Interface, JsonRpcProvider, toBeHex, toQuantity, type BlockTag } from "ethers";
import { clearingApproverAbi } from "../../../packages/shared/src/abi.js";
import {
  toExposureBook,
  toExposureMarket,
  toPosition,
  toSession,
  type ClearingBookStruct,
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
  marketLimitWord(market: number, at: At): Promise<bigint>;
  exposureState(market: number, at: At): Promise<ClearingBookStruct>;
  positionOf(account: string, market: number, at: At): Promise<ClearingPositionStruct>;
  sessions(signer: string, at: At): Promise<ClearingSessionStruct>;
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
}

const ERC1271_MAGIC_VALUE = "0x1626ba7e";

export function createChainClients(
  provider: JsonRpcProvider,
  secondaryProvider: JsonRpcProvider | undefined,
  clearingAddress: string,
): ChainClients {
  return {
    provider,
    secondaryProvider,
    clearing: new Contract(clearingAddress, clearingApproverAbi, provider) as unknown as ClearingReader,
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
  /** Packed `marketLimitWord` per market index. */
  limitWords: bigint[];
  /** The intent account's position in the intent market. */
  position: PositionState;
  backing: bigint;
  floor: bigint;
  /** EOA signature by the account, or a valid ERC-1271 signature from it. */
  accountSignatureValid: boolean;
  /** Session of a non-account ECDSA signer. */
  session?: SessionState;
}

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
  const signedByAccount = intentSigner === intent.account;
  const [
    block,
    secondaryBlock,
    leaderEpoch,
    signerSetVersion,
    policyVersion,
    paused,
    resolutionRequired,
    isApprover,
    rawMarkets,
    limitWords,
    accountSignatureValid,
    session,
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
    clearing.isApprover(request.signer, at),
    Promise.all(indexes.map((index) => clearing.markets(index, at))),
    Promise.all(indexes.map(async (index) => BigInt(await clearing.marketLimitWord(index, at)))),
    signedByAccount
      ? Promise.resolve(true)
      : chain.isValidSignature(intent.account, request.intentHash, request.userSignature, blockNumber),
    signedByAccount || intentSigner === undefined
      ? Promise.resolve(undefined)
      : clearing.sessions(intentSigner, at),
    clearing.positionOf(intent.account, market, at),
    Promise.all(indexes.map((index) => clearing.exposureState(index, at))),
    clearing.makerBacking(at),
    clearing.baseRiskCapitalTarget(at),
  ]);
  if (secondaryProvider && (!secondaryBlock || secondaryBlock.hash !== block?.hash))
    return { rejection: reject("rpc divergence") };
  if (!block) return { rejection: reject("independent chain policy rejected") };
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
      accountSignatureValid: Boolean(accountSignatureValid),
      session: session && toSession(session),
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
