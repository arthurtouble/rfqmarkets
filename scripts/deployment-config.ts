import { getAddress } from "ethers";
import { z } from "zod";

const address=z.string().regex(/^0x[0-9a-fA-F]{40}$/).transform(getAddress);
const feed=z.string().regex(/^0x[0-9a-fA-F]{64}$/);
const schema=z.object({
  RFQ_BASE_SEPOLIA_RPC_URL:z.string().url().refine(value=>value.startsWith("https://"),"RPC URL must use HTTPS"),
  RFQ_DEPLOYER_KEY:z.string().regex(/^0x[0-9a-fA-F]{64}$/),
  RFQ_USDC_ADDRESS:address,
  RFQ_VERIFIER_PROXY_ADDRESS:address,
  RFQ_GOVERNANCE_ADDRESS:address,
  RFQ_EMERGENCY_COUNCIL_ADDRESS:address,
  RFQ_APPROVER_1_ADDRESS:address,RFQ_APPROVER_2_ADDRESS:address,RFQ_APPROVER_3_ADDRESS:address,
  RFQ_BTC_FEED_ID:feed,RFQ_ETH_FEED_ID:feed,
  RFQ_BTC_FEED_DECIMALS:z.coerce.number().int().min(6).max(18).default(8),
  RFQ_ETH_FEED_DECIMALS:z.coerce.number().int().min(6).max(18).default(8),
  RFQ_BASE_RISK_CAPITAL_USDC:z.coerce.number().int().min(100_000).max(1_000_000).default(600_000),
});

export function loadDeploymentConfig(env:NodeJS.ProcessEnv){
  const value=schema.parse(env),approvers=[value.RFQ_APPROVER_1_ADDRESS,value.RFQ_APPROVER_2_ADDRESS,value.RFQ_APPROVER_3_ADDRESS] as [string,string,string];
  const roles=[value.RFQ_USDC_ADDRESS,value.RFQ_VERIFIER_PROXY_ADDRESS,value.RFQ_GOVERNANCE_ADDRESS,value.RFQ_EMERGENCY_COUNCIL_ADDRESS,...approvers];
  if(new Set(roles.map(item=>item.toLowerCase())).size!==roles.length)throw new Error("deployment role addresses must be distinct");
  if(value.RFQ_BTC_FEED_ID.toLowerCase()===value.RFQ_ETH_FEED_ID.toLowerCase())throw new Error("BTC and ETH feed IDs must differ");
  return {rpcUrl:value.RFQ_BASE_SEPOLIA_RPC_URL,deployerKey:value.RFQ_DEPLOYER_KEY,usdc:value.RFQ_USDC_ADDRESS,verifier:value.RFQ_VERIFIER_PROXY_ADDRESS,governance:value.RFQ_GOVERNANCE_ADDRESS,emergencyCouncil:value.RFQ_EMERGENCY_COUNCIL_ADDRESS,approvers,feedIds:[value.RFQ_BTC_FEED_ID,value.RFQ_ETH_FEED_ID] as [string,string],feedDecimals:[value.RFQ_BTC_FEED_DECIMALS,value.RFQ_ETH_FEED_DECIMALS] as [number,number],baseRiskCapital:BigInt(value.RFQ_BASE_RISK_CAPITAL_USDC)*1_000_000n};
}
