import { TypedDataEncoder, getAddress, verifyTypedData } from "ethers";

export const DOMAIN_NAME = "RFQ Markets";
export const DOMAIN_VERSION = "1";

export const intentTypes: Record<string, Array<{ name: string; type: string }>> = {
  TradeIntent: [
    { name: "account", type: "address" },
    { name: "market", type: "uint8" },
    { name: "baseDelta", type: "int256" },
    { name: "limitPrice", type: "uint256" },
    { name: "maxFee", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint64" },
    { name: "reduceOnly", type: "bool" },
  ],
};

/**
 * A trade intent that only fills once the oracle mid has reached `triggerPrice` (stop-loss,
 * take-profit, stop entry). Its own primary type, so it can never fill through `executeTrade`.
 */
export const triggeredIntentTypes: Record<string, Array<{ name: string; type: string }>> = {
  TriggeredTradeIntent: [
    ...intentTypes.TradeIntent,
    { name: "triggerPrice", type: "uint256" },
    { name: "triggerAbove", type: "bool" },
  ],
};

export const approvalTypes: Record<string, Array<{ name: string; type: string }>> = {
  MakerApproval: [
    { name: "intentHash", type: "bytes32" },
    { name: "executionPrice", type: "uint256" },
    { name: "impactCharge", type: "int256" },
    { name: "fee", type: "uint256" },
    { name: "oracleReportHash", type: "bytes32" },
    { name: "deadline", type: "uint64" },
    { name: "leaderEpoch", type: "uint64" },
    { name: "signerSetVersion", type: "uint64" },
    { name: "policyVersion", type: "uint64" },
  ],
};

export const depositTypes: Record<string, Array<{ name: string; type: string }>> = {
  DepositIntent: [
    { name: "account", type: "address" },
    { name: "routeId", type: "bytes32" },
    { name: "sourceChainId", type: "uint256" },
    { name: "sourceTokenHash", type: "bytes32" },
    { name: "sourceAmount", type: "uint256" },
    { name: "minimumUsdc", type: "uint256" },
    { name: "deadline", type: "uint64" },
    { name: "nonce", type: "uint256" },
  ],
};
export const withdrawalTypes: Record<string, Array<{ name: string; type: string }>> = {
  WithdrawalIntent: [
    { name: "account", type: "address" },
    { name: "recipient", type: "address" },
    { name: "amount", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint64" },
  ],
};
export const cancelTypes: Record<string, Array<{ name: string; type: string }>> = {
  CancelIntent: [
    { name: "account", type: "address" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint64" },
  ],
};
export const closeTypes: Record<string, Array<{ name: string; type: string }>> = {
  CloseIntent: [
    { name: "account", type: "address" },
    { name: "market", type: "uint8" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint64" },
  ],
};
export const sessionGrantTypes: Record<string, Array<{ name: string; type: string }>> = {
  SessionGrant: [
    { name: "account", type: "address" },
    { name: "session", type: "address" },
    { name: "marketMask", type: "uint256" },
    { name: "maxTradeNotional", type: "uint128" },
    { name: "maxCumulativeNotional", type: "uint128" },
    { name: "maxFee", type: "uint128" },
    { name: "validUntil", type: "uint64" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint64" },
  ],
};

export interface SigningDomain {
  name: string;
  version: string;
  chainId: bigint;
  verifyingContract: string;
}
export interface TradeIntent {
  account: string;
  market: number;
  baseDelta: bigint;
  limitPrice: bigint;
  maxFee: bigint;
  nonce: bigint;
  deadline: bigint;
  reduceOnly: boolean;
}
/** `RFQTypes.Trigger`: fill only when the report mid is >= (`triggerAbove`) or <= `triggerPrice`. */
export interface Trigger {
  triggerPrice: bigint;
  triggerAbove: boolean;
}
export interface MakerApproval {
  intentHash: string;
  executionPrice: bigint;
  impactCharge: bigint;
  fee: bigint;
  oracleReportHash: string;
  deadline: bigint;
  leaderEpoch: bigint;
  signerSetVersion: bigint;
  policyVersion: bigint;
}
export interface DepositIntent {
  account: string;
  routeId: string;
  sourceChainId: bigint;
  sourceTokenHash: string;
  sourceAmount: bigint;
  minimumUsdc: bigint;
  deadline: bigint;
  nonce: bigint;
}
export interface WithdrawalIntent {
  account: string;
  recipient: string;
  amount: bigint;
  nonce: bigint;
  deadline: bigint;
}
export interface CancelIntent {
  account: string;
  nonce: bigint;
  deadline: bigint;
}
export interface CloseIntent {
  account: string;
  market: number;
  nonce: bigint;
  deadline: bigint;
}
export interface SessionGrant {
  account: string;
  session: string;
  marketMask: number;
  maxTradeNotional: bigint;
  maxCumulativeNotional: bigint;
  maxFee: bigint;
  validUntil: bigint;
  nonce: bigint;
  deadline: bigint;
}

export const hashIntent = (domain: SigningDomain, intent: TradeIntent) =>
  TypedDataEncoder.hash(domain, intentTypes, intent);
/** The typed message a wallet signs for a triggered order: the intent fields followed by the trigger. */
export const triggeredMessage = (intent: TradeIntent, trigger: Trigger) => ({
  account: intent.account,
  market: intent.market,
  baseDelta: intent.baseDelta,
  limitPrice: intent.limitPrice,
  maxFee: intent.maxFee,
  nonce: intent.nonce,
  deadline: intent.deadline,
  reduceOnly: intent.reduceOnly,
  triggerPrice: trigger.triggerPrice,
  triggerAbove: trigger.triggerAbove,
});
export const hashTriggeredIntent = (domain: SigningDomain, intent: TradeIntent, trigger: Trigger) =>
  TypedDataEncoder.hash(domain, triggeredIntentTypes, triggeredMessage(intent, trigger));
/** The digest a maker approval binds: the triggered digest when the intent carries a trigger. */
export const intentDigest = (domain: SigningDomain, intent: TradeIntent, trigger?: Trigger) =>
  trigger ? hashTriggeredIntent(domain, intent, trigger) : hashIntent(domain, intent);
export const recoverTriggeredIntentSigner = (
  domain: SigningDomain,
  intent: TradeIntent,
  trigger: Trigger,
  signature: string,
) => getAddress(verifyTypedData(domain, triggeredIntentTypes, triggeredMessage(intent, trigger), signature));
/** ECDSA signer of a plain or triggered intent. Throws when the signature does not recover. */
export const recoverDigestSigner = (
  domain: SigningDomain,
  intent: TradeIntent,
  signature: string,
  trigger?: Trigger,
) =>
  trigger
    ? recoverTriggeredIntentSigner(domain, intent, trigger, signature)
    : recoverIntentSigner(domain, intent, signature);
export const hashApproval = (domain: SigningDomain, approval: MakerApproval) =>
  TypedDataEncoder.hash(domain, approvalTypes, approval);
export const recoverIntentSigner = (domain: SigningDomain, intent: TradeIntent, signature: string) =>
  getAddress(verifyTypedData(domain, intentTypes, intent, signature));
export const recoverDepositSigner = (domain: SigningDomain, intent: DepositIntent, signature: string) =>
  getAddress(verifyTypedData(domain, depositTypes, intent, signature));
export const recoverWithdrawalSigner = (domain: SigningDomain, intent: WithdrawalIntent, signature: string) =>
  getAddress(verifyTypedData(domain, withdrawalTypes, intent, signature));
export const recoverCancelSigner = (domain: SigningDomain, intent: CancelIntent, signature: string) =>
  getAddress(verifyTypedData(domain, cancelTypes, intent, signature));
export const recoverCloseSigner = (domain: SigningDomain, intent: CloseIntent, signature: string) =>
  getAddress(verifyTypedData(domain, closeTypes, intent, signature));
export const recoverSessionGrantSigner = (domain: SigningDomain, grant: SessionGrant, signature: string) =>
  getAddress(verifyTypedData(domain, sessionGrantTypes, grant, signature));

type Wire<T> = { [K in keyof T]: T[K] extends bigint ? string : T[K] };

/** Inverse of the `*ToWire` serializers; throws on malformed integers or addresses. */
export const domainFromWire = (domain: Wire<SigningDomain>): SigningDomain => ({
  ...domain,
  chainId: BigInt(domain.chainId),
  verifyingContract: getAddress(domain.verifyingContract),
});
export const intentFromWire = (intent: Wire<TradeIntent>): TradeIntent => ({
  ...intent,
  account: getAddress(intent.account),
  baseDelta: BigInt(intent.baseDelta),
  limitPrice: BigInt(intent.limitPrice),
  maxFee: BigInt(intent.maxFee),
  nonce: BigInt(intent.nonce),
  deadline: BigInt(intent.deadline),
});
export const approvalFromWire = (approval: Wire<MakerApproval>): MakerApproval => ({
  ...approval,
  executionPrice: BigInt(approval.executionPrice),
  impactCharge: BigInt(approval.impactCharge),
  fee: BigInt(approval.fee),
  deadline: BigInt(approval.deadline),
  leaderEpoch: BigInt(approval.leaderEpoch),
  signerSetVersion: BigInt(approval.signerSetVersion),
  policyVersion: BigInt(approval.policyVersion),
});

export const triggerFromWire = (trigger: Wire<Trigger>): Trigger => ({
  triggerPrice: BigInt(trigger.triggerPrice),
  triggerAbove: trigger.triggerAbove,
});
export const triggerToWire = (trigger: Trigger) => ({
  triggerPrice: trigger.triggerPrice.toString(),
  triggerAbove: trigger.triggerAbove,
});
/** Wire form of the full `TriggeredTradeIntent` message, as handed to a wallet for signing. */
export const triggeredIntentToWire = (intent: TradeIntent, trigger: Trigger) => ({
  ...intentToWire(intent),
  ...triggerToWire(trigger),
});

export const intentToWire = (intent: TradeIntent) => ({
  ...intent,
  baseDelta: intent.baseDelta.toString(),
  limitPrice: intent.limitPrice.toString(),
  maxFee: intent.maxFee.toString(),
  nonce: intent.nonce.toString(),
  deadline: intent.deadline.toString(),
});

export const approvalToWire = (approval: MakerApproval) => ({
  ...approval,
  executionPrice: approval.executionPrice.toString(),
  impactCharge: approval.impactCharge.toString(),
  fee: approval.fee.toString(),
  deadline: approval.deadline.toString(),
  leaderEpoch: approval.leaderEpoch.toString(),
  signerSetVersion: approval.signerSetVersion.toString(),
  policyVersion: approval.policyVersion.toString(),
});
export const depositToWire = (intent: DepositIntent) => ({
  ...intent,
  sourceChainId: intent.sourceChainId.toString(),
  sourceAmount: intent.sourceAmount.toString(),
  minimumUsdc: intent.minimumUsdc.toString(),
  deadline: intent.deadline.toString(),
  nonce: intent.nonce.toString(),
});
export const withdrawalToWire = (intent: WithdrawalIntent) => ({
  ...intent,
  amount: intent.amount.toString(),
  nonce: intent.nonce.toString(),
  deadline: intent.deadline.toString(),
});
export const cancelToWire = (intent: CancelIntent) => ({
  ...intent,
  nonce: intent.nonce.toString(),
  deadline: intent.deadline.toString(),
});
export const closeToWire = (intent: CloseIntent) => ({
  ...intent,
  nonce: intent.nonce.toString(),
  deadline: intent.deadline.toString(),
});
export const sessionGrantToWire = (grant: SessionGrant) => ({
  ...grant,
  maxTradeNotional: grant.maxTradeNotional.toString(),
  maxCumulativeNotional: grant.maxCumulativeNotional.toString(),
  maxFee: grant.maxFee.toString(),
  validUntil: grant.validUntil.toString(),
  nonce: grant.nonce.toString(),
  deadline: grant.deadline.toString(),
});
