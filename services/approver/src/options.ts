import type { JsonRpcProvider } from "ethers";

/** "local" decodes MockPriceOracle reports; "signed" dry-runs the SignedPriceOracle adapter on chain. */
export type OracleMode = "local" | "signed";
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
  hedgeRisk?: HedgeRiskConfig;
  /** Transport for the hedger risk snapshot; defaults to global `fetch`. */
  fetchImpl?: typeof fetch;
}

/** Tolerated clock skew between this approver, the leader and the chain. */
export const DEFAULT_MAX_FUTURE_SECONDS = 5;
