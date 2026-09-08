import { TypedDataEncoder, getAddress, verifyTypedData } from "ethers";

export const DOMAIN_NAME = "RFQ Markets";
export const DOMAIN_VERSION = "1";

export const intentTypes:Record<string,Array<{name:string;type:string}>> = {
  TradeIntent: [
    { name: "account", type: "address" }, { name: "market", type: "uint8" },
    { name: "baseDelta", type: "int256" }, { name: "limitPrice", type: "uint256" },
    { name: "maxFee", type: "uint256" }, { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint64" }, { name: "leaderEpoch", type: "uint64" },
    { name: "policyVersion", type: "uint64" }, { name: "reduceOnly", type: "bool" },
  ],
};

export const approvalTypes:Record<string,Array<{name:string;type:string}>> = {
  MakerApproval: [
    { name: "intentHash", type: "bytes32" }, { name: "executionPrice", type: "uint256" },
    { name: "impactCharge", type: "int256" }, { name: "fee", type: "uint256" },
    { name: "oracleReportHash", type: "bytes32" }, { name: "deadline", type: "uint64" },
    { name: "leaderEpoch", type: "uint64" }, { name: "signerSetVersion", type: "uint64" },
    { name: "policyVersion", type: "uint64" },
  ],
};

export const depositTypes:Record<string,Array<{name:string;type:string}>> = {
  DepositIntent: [
    {name:"account",type:"address"},{name:"routeId",type:"bytes32"},{name:"sourceChainId",type:"uint256"},
    {name:"sourceTokenHash",type:"bytes32"},{name:"sourceAmount",type:"uint256"},{name:"minimumUsdc",type:"uint256"},
    {name:"deadline",type:"uint64"},{name:"nonce",type:"uint256"},
  ],
};

export interface SigningDomain { name: string; version: string; chainId: bigint; verifyingContract: string }
export interface TradeIntent {
  account:string; market:number; baseDelta:bigint; limitPrice:bigint; maxFee:bigint; nonce:bigint;
  deadline:bigint; leaderEpoch:bigint; policyVersion:bigint; reduceOnly:boolean;
}
export interface MakerApproval {
  intentHash:string; executionPrice:bigint; impactCharge:bigint; fee:bigint; oracleReportHash:string;
  deadline:bigint; leaderEpoch:bigint; signerSetVersion:bigint; policyVersion:bigint;
}
export interface DepositIntent {account:string;routeId:string;sourceChainId:bigint;sourceTokenHash:string;sourceAmount:bigint;minimumUsdc:bigint;deadline:bigint;nonce:bigint}

export const hashIntent = (domain: SigningDomain, intent: TradeIntent) => TypedDataEncoder.hash(domain, intentTypes, intent);
export const hashApproval = (domain: SigningDomain, approval: MakerApproval) => TypedDataEncoder.hash(domain, approvalTypes, approval);
export const recoverIntentSigner = (domain: SigningDomain, intent: TradeIntent, signature: string) => getAddress(verifyTypedData(domain, intentTypes, intent, signature));
export const recoverDepositSigner = (domain:SigningDomain,intent:DepositIntent,signature:string)=>getAddress(verifyTypedData(domain,depositTypes,intent,signature));

export const intentToWire = (intent: TradeIntent) => ({
  ...intent, baseDelta:intent.baseDelta.toString(), limitPrice:intent.limitPrice.toString(), maxFee:intent.maxFee.toString(),
  nonce:intent.nonce.toString(), deadline:intent.deadline.toString(), leaderEpoch:intent.leaderEpoch.toString(), policyVersion:intent.policyVersion.toString(),
});

export const approvalToWire = (approval: MakerApproval) => ({
  ...approval, executionPrice:approval.executionPrice.toString(), impactCharge:approval.impactCharge.toString(), fee:approval.fee.toString(),
  deadline:approval.deadline.toString(), leaderEpoch:approval.leaderEpoch.toString(), signerSetVersion:approval.signerSetVersion.toString(), policyVersion:approval.policyVersion.toString(),
});
export const depositToWire=(intent:DepositIntent)=>({...intent,sourceChainId:intent.sourceChainId.toString(),sourceAmount:intent.sourceAmount.toString(),minimumUsdc:intent.minimumUsdc.toString(),deadline:intent.deadline.toString(),nonce:intent.nonce.toString()});
