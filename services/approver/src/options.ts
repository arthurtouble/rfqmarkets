import type { JsonRpcProvider } from "ethers";

export type OracleMode = "local" | "chainlink" | "pyth";
export interface DataStreamsConfig {
  feedIds: [string, string];
  feedDecimals: [number, number];
}
export interface HedgeRiskConfig {
  url: string;
  token: string;
  maxAgeMs?: number;
}

export interface ApproverOptions {
  provider?: JsonRpcProvider;
  privateKey: string;
  transportToken: string;
  databasePath: string;
  expectedEpoch?: number;
  expectedPolicyVersion?: number;
  expectedSignerSetVersion?: number;
  expectedQuoteModelVersion?: string;
  expectedChainId?: bigint;
  expectedVerifyingContract?: string;
  rpcUrl?: string;
  secondaryRpcUrl?: string;
  rpcBatchMaxCount?: number;
  maxFutureSeconds?: number;
  oracleMode?: OracleMode;
  dataStreams?: DataStreamsConfig;
  hedgeRisk?: HedgeRiskConfig;
  /** Transport for the hedger risk snapshot; defaults to global `fetch`. */
  fetchImpl?: typeof fetch;
}

/** Tolerated clock skew between this approver, the leader and the chain. */
export const DEFAULT_MAX_FUTURE_SECONDS = 5;
