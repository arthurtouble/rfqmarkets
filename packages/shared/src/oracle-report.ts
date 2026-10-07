import { AbiCoder, type BigNumberish, type BytesLike } from "ethers";

/** ABI tuple of one oracle observation; adapters return an array of them, one per market. */
export const ORACLE_OBSERVATION_TUPLE =
  "tuple(uint8 market,uint256 bid,uint256 ask,uint64 observedAt,uint64 validUntil)";

/** Oracle adapter surface used by off-chain services (fee quote and dry-run verification). */
export const oracleAdapterAbi = [
  "function updateFee(bytes) view returns(uint256)",
  `function verify(bytes) payable returns(${ORACLE_OBSERVATION_TUPLE}[])`,
] as const;

export interface OracleObservation {
  market: bigint;
  bid: bigint;
  ask: bigint;
  observedAt: bigint;
  validUntil: bigint;
}

export type OracleObservationInput = Record<keyof OracleObservation, BigNumberish>;

/** Normalize an ABI-decoded observation (ethers `Result` or plain object) to bigints. */
export function toOracleObservation(value: OracleObservationInput): OracleObservation {
  return {
    market: BigInt(value.market),
    bid: BigInt(value.bid),
    ask: BigInt(value.ask),
    observedAt: BigInt(value.observedAt),
    validUntil: BigInt(value.validUntil),
  };
}

/**
 * Encode a local-adapter oracle report: the ABI-encoded observation array, in ascending market order.
 * A single observation encodes a one-market report.
 */
export function encodeLocalReport(observations: OracleObservationInput | OracleObservationInput[]): string {
  const list = Array.isArray(observations) ? observations : [observations];
  return AbiCoder.defaultAbiCoder().encode(
    [`${ORACLE_OBSERVATION_TUPLE}[]`],
    [list.map(({ market, bid, ask, observedAt, validUntil }) => [market, bid, ask, observedAt, validUntil])],
  );
}

export function decodeLocalReport(report: BytesLike): OracleObservation[] {
  const [values] = AbiCoder.defaultAbiCoder().decode([`${ORACLE_OBSERVATION_TUPLE}[]`], report);
  return Array.from(values as OracleObservationInput[], toOracleObservation);
}

/** ABI tuple of one node's signed batch inside a signed-oracle report (`abi.encode(SignedPriceBatch[])`). */
export const SIGNED_PRICE_BATCH_TUPLE =
  "tuple(uint64 observedAt,tuple(uint8 market,uint256 bid,uint256 ask)[] prices,bytes signature)";

export interface SignedPriceBatch {
  observedAt: bigint;
  prices: { market: bigint; bid: bigint; ask: bigint }[];
  signature: string;
}

export function encodeSignedReport(batches: SignedPriceBatch[]): string {
  return AbiCoder.defaultAbiCoder().encode(
    [`${SIGNED_PRICE_BATCH_TUPLE}[]`],
    [batches.map((batch) => [batch.observedAt, batch.prices.map((p) => [p.market, p.bid, p.ask]), batch.signature])],
  );
}

export function decodeSignedReport(report: BytesLike): SignedPriceBatch[] {
  const [values] = AbiCoder.defaultAbiCoder().decode([`${SIGNED_PRICE_BATCH_TUPLE}[]`], report);
  return Array.from(values as { observedAt: bigint; prices: { market: bigint; bid: bigint; ask: bigint }[]; signature: string }[], (batch) => ({
    observedAt: BigInt(batch.observedAt),
    prices: Array.from(batch.prices, (p) => ({ market: BigInt(p.market), bid: BigInt(p.bid), ask: BigInt(p.ask) })),
    signature: String(batch.signature),
  }));
}

/** Markets priced by at least one batch of a signed report; the adapter decides which survive consensus. */
export function signedReportMarkets(report: BytesLike): Set<bigint> {
  return new Set(decodeSignedReport(report).flatMap((batch) => batch.prices.map((p) => p.market)));
}
