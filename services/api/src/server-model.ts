import type { DepositIntent, TradeIntent } from "../../../packages/shared/src/eip712.js";

export type DepositRoute = {
  intent: DepositIntent;
  fromToken: "USDC" | "USDT" | "ETH";
  amount: string;
  expectedUsdc: bigint;
  status: "quoted" | "authorized" | "deposited";
  destinationTxHash?: string;
  transaction?: { hash: string; blockNumber: number; collateral: string };
};

export type ProtocolVersions = {
  leaderEpoch: bigint;
  signerSetVersion: bigint;
  policyVersion: bigint;
  blockNumber: number;
  blockTimestamp: number;
};

export type RestingOrder = {
  orderId: string;
  intent: TradeIntent;
  market: "BTC" | "ETH";
  side: "buy" | "sell";
  amount: string;
  userSignature?: string;
  status: "prepared" | "open" | "executing" | "filled" | "cancelled" | "expired";
  createdAtMs: number;
  updatedAtMs: number;
  transactionHash?: string;
  lastError?: string;
};
