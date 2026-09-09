import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { Wallet } from "ethers";

const directory=resolve(".local-state"),secretPath=resolve(directory,"testnet-identities.json"),addressPath=resolve(directory,"testnet-addresses.json"),envPath=resolve("base-sepolia.env");mkdirSync(directory,{recursive:true});
type Identity={address:string;privateKey:string};type Bundle={createdAt:string;deployer:Identity;governanceController:Identity;governanceOwners:[Identity,Identity,Identity];emergencyCouncil:Identity;emergencyOwners:[Identity,Identity,Identity];sponsor:Identity;approvers:[Identity,Identity,Identity];hyperliquidAgent:Identity};
const make=():Identity=>{const wallet=Wallet.createRandom();return {address:wallet.address,privateKey:wallet.privateKey};};
let bundle:Bundle;
if(existsSync(secretPath)){
  const stored=JSON.parse(readFileSync(secretPath,"utf8")) as Partial<Bundle>&Pick<Bundle,"createdAt"|"deployer"|"governanceController"|"emergencyCouncil"|"sponsor"|"approvers"|"hyperliquidAgent">;
  bundle={...stored,governanceOwners:stored.governanceOwners??[stored.governanceController,make(),make()],emergencyOwners:stored.emergencyOwners??[stored.emergencyCouncil,make(),make()]} as Bundle;
}else bundle={createdAt:new Date().toISOString(),deployer:make(),governanceController:make(),governanceOwners:[make(),make(),make()],emergencyCouncil:make(),emergencyOwners:[make(),make(),make()],sponsor:make(),approvers:[make(),make(),make()],hyperliquidAgent:make()};
writeFileSync(secretPath,JSON.stringify(bundle,null,2),{mode:0o600});chmodSync(secretPath,0o600);
const addresses={createdAt:bundle.createdAt,deployer:bundle.deployer.address,governanceOwners:bundle.governanceOwners.map(item=>item.address),emergencyOwners:bundle.emergencyOwners.map(item=>item.address),sponsor:bundle.sponsor.address,approvers:bundle.approvers.map(item=>item.address),hyperliquidAgent:bundle.hyperliquidAgent.address};writeFileSync(addressPath,JSON.stringify(addresses,null,2));console.log(JSON.stringify(addresses,null,2));
if(!existsSync(envPath)){
  const env=[
    "RFQ_BASE_SEPOLIA_RPC_URL=https://sepolia.base.org",
    `RFQ_DEPLOYER_KEY=${bundle.deployer.privateKey}`,
    "RFQ_USDC_ADDRESS=0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    "RFQ_ORACLE_MODE=pyth",
    "RFQ_VERIFIER_PROXY_ADDRESS=0xreplace_with_verified_chainlink_verifier_proxy",
    "RFQ_PYTH_CORE_ADDRESS=0x5f52e4DBEA21f5b23523B6e20d50c29ae0a4EB83",
    "RFQ_GOVERNANCE_ADDRESS=0xreplace_with_deployed_timelock",
    "RFQ_EMERGENCY_COUNCIL_ADDRESS=0xreplace_with_emergency_safe",
    `RFQ_APPROVER_1_ADDRESS=${bundle.approvers[0].address}`,
    `RFQ_APPROVER_2_ADDRESS=${bundle.approvers[1].address}`,
    `RFQ_APPROVER_3_ADDRESS=${bundle.approvers[2].address}`,
    "RFQ_BTC_FEED_ID=0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43",
    "RFQ_ETH_FEED_ID=0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace",
    "RFQ_BTC_FEED_DECIMALS=8",
    "RFQ_ETH_FEED_DECIMALS=8",
    "RFQ_BASE_RISK_CAPITAL_USDC=600000",
    "RFQ_DATA_STREAMS_API_KEY=replace_with_scoped_api_key",
    "RFQ_DATA_STREAMS_USER_SECRET=replace_with_scoped_user_secret",
    "RFQ_DATA_STREAMS_ENDPOINT=https://api.testnet-dataengine.chain.link",
    "RFQ_DATA_STREAMS_WS_ENDPOINT=wss://ws.testnet-dataengine.chain.link",
    "",
  ].join("\n");
  writeFileSync(envPath,env,{mode:0o600});chmodSync(envPath,0o600);
}
