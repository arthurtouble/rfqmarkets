import type { BaseContract, Signer } from "ethers";

export interface MarketConfig {
  enabled: boolean;
  maxTradeNotional: bigint;
  maxMarketNotional: bigint;
  grossLimit: bigint;
  sideLimit: bigint;
}

export const BASE: bigint;
export const MAX_MARKET_CONFIG: MarketConfig;
export const TRADE_INTENT_TYPES: Record<string, { name: string; type: string }[]>;
export const MAKER_APPROVAL_TYPES: Record<string, { name: string; type: string }[]>;

export function artifact(name: string, root?: string): { abi: unknown[]; bytecode: string; linkReferences?: Record<string, Record<string, unknown>> };
export function linkedLibraries(item: { linkReferences?: Record<string, Record<string, unknown>> }): string[];
export function deployLinked(
  signer: Signer,
  name: string,
  args?: unknown[],
  libraries?: Record<string, string>,
): Promise<BaseContract & Record<string, any>>;
export function deployClearing(options: Record<string, unknown>): Promise<Record<string, any>>;
export function encodeObservation(observation: {
  market: number;
  bid: bigint;
  ask?: bigint;
  observedAt: number | bigint;
  validUntil: number | bigint;
}): string;
