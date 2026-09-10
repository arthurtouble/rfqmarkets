import { readFileSync } from "node:fs";
import { resolve } from "node:path";

type Identity={address:string;privateKey:string};
const identities=JSON.parse(readFileSync(resolve(".local-state/testnet-identities.json"),"utf8")) as {deployer:Identity};

// The governed deployment remains the production-governance rehearsal. This
// disposable profile makes Base Sepolia contract iteration immediate.
process.env.RFQ_GOVERNANCE_ADDRESS=identities.deployer.address;
process.env.RFQ_BASE_SEPOLIA_DEPLOYMENT_FILE=".local-state/base-sepolia-iteration.json";
process.env.RFQ_TESTNET_ITERATION="true";
await import("./deploy-base-sepolia.js");
