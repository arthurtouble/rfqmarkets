import {chmodSync,readFileSync,writeFileSync} from "node:fs";
import {resolve} from "node:path";

const source=resolve(process.argv[2]??"base-sepolia.env");
const manifestPath=resolve(process.argv[3]??".local-state/base-sepolia-iteration.json");
const identitiesPath=resolve(".local-state/testnet-identities.json");
const destination=resolve(".local-state/cloudflare-runtime-secret.json");
const allowed=new Set([
  "RFQ_BASE_SEPOLIA_RPC_URL","RFQ_API_RPC_URL","RFQ_PUBLIC_RPC_URL","RFQ_ORACLE_MODE","PYTH_API_KEY",
  "RFQ_HEDGE_VENUE","RFQ_HYPERLIQUID_API_URL","RFQ_HYPERLIQUID_ACCOUNT_ADDRESS","RFQ_HYPERLIQUID_AGENT_NAME",
  "RFQ_HYPERLIQUID_MIN_PERP_USDC","RFQ_HEDGE_BAND_USDC","RFQ_HEDGE_MAX_ORDER_USDC","RFQ_HEDGE_MIN_ORDER_USDC",
  "RFQ_APPROVER_RPC_URLS","RFQ_APPROVER_SECONDARY_RPC_URLS","RFQ_APPROVER_TIMEOUT_MS","RFQ_HEDGE_RISK_MAX_AGE_MS",
]);
const values:Record<string,string>={};
for(const input of readFileSync(source,"utf8").split(/\r?\n/)){
  const line=input.trim();if(!line||line.startsWith("#"))continue;
  const match=/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);if(!match||!allowed.has(match[1]))continue;
  let value=match[2].trim();if((value.startsWith('"')&&value.endsWith('"'))||(value.startsWith("'")&&value.endsWith("'")))value=value.slice(1,-1);
  if(value&&!value.startsWith("replace_"))values[match[1]]=value;
}
for(const required of ["RFQ_BASE_SEPOLIA_RPC_URL","RFQ_ORACLE_MODE","PYTH_API_KEY","RFQ_HYPERLIQUID_ACCOUNT_ADDRESS","RFQ_HYPERLIQUID_AGENT_NAME"])if(!values[required])throw new Error(`missing runtime setting ${required}`);
values.RFQ_TESTNET_MANIFEST_JSON=JSON.stringify(JSON.parse(readFileSync(manifestPath,"utf8")));
const identities=JSON.parse(readFileSync(identitiesPath,"utf8"));
values.RFQ_TESTNET_IDENTITIES_JSON=JSON.stringify({sponsor:identities.sponsor,approvers:identities.approvers,hyperliquidAgent:identities.hyperliquidAgent});
writeFileSync(destination,JSON.stringify(values),{mode:0o600});chmodSync(destination,0o600);
console.log(`Prepared ignored Cloudflare runtime secret (${Object.keys(values).length} fields)`);
