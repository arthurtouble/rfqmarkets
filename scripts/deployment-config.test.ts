import assert from "node:assert/strict";
import test from "node:test";
import { loadDeploymentConfig } from "./deployment-config.js";

const valid={RFQ_BASE_SEPOLIA_RPC_URL:"https://rpc.example",RFQ_DEPLOYER_KEY:`0x${"11".repeat(32)}`,RFQ_USDC_ADDRESS:`0x${"01".repeat(20)}`,RFQ_VERIFIER_PROXY_ADDRESS:`0x${"02".repeat(20)}`,RFQ_GOVERNANCE_ADDRESS:`0x${"03".repeat(20)}`,RFQ_EMERGENCY_COUNCIL_ADDRESS:`0x${"04".repeat(20)}`,RFQ_APPROVER_1_ADDRESS:`0x${"05".repeat(20)}`,RFQ_APPROVER_2_ADDRESS:`0x${"06".repeat(20)}`,RFQ_APPROVER_3_ADDRESS:`0x${"07".repeat(20)}`,RFQ_BTC_FEED_ID:`0x${"08".repeat(32)}`,RFQ_ETH_FEED_ID:`0x${"09".repeat(32)}`};
test("Base Sepolia deployment config validates and normalizes roles",()=>{const config=loadDeploymentConfig(valid);assert.equal(config.baseRiskCapital,600_000_000_000n);assert.equal(config.approvers.length,3);});
test("deployment config rejects duplicate authorities",()=>assert.throws(()=>loadDeploymentConfig({...valid,RFQ_APPROVER_3_ADDRESS:valid.RFQ_APPROVER_2_ADDRESS}),/distinct/));
test("deployment config rejects plaintext RPC transport",()=>assert.throws(()=>loadDeploymentConfig({...valid,RFQ_BASE_SEPOLIA_RPC_URL:"http://rpc.example"}),/HTTPS/));
test("deployment config accepts the Pyth Core fallback",()=>{const config=loadDeploymentConfig({...valid,RFQ_ORACLE_MODE:"pyth",RFQ_VERIFIER_PROXY_ADDRESS:undefined,RFQ_PYTH_CORE_ADDRESS:`0x${"10".repeat(20)}`});assert.equal(config.oracleMode,"pyth");assert.equal(config.oracleAddress,`0x${"10".repeat(20)}`);});
