import assert from "node:assert/strict";
import test from "node:test";
import { Wallet } from "ethers";
import { devConfirmation, devManifestFor, oracleSignersFor, type RuntimeIdentities } from "./base-mainnet-dev-ci.js";
import { validateDevManifest } from "./mainnet-manifest.js";

const owner=Wallet.createRandom().address,runtime:RuntimeIdentities={emergency:Wallet.createRandom().address,approvers:[Wallet.createRandom().address,Wallet.createRandom().address,Wallet.createRandom().address],sponsor:Wallet.createRandom().address};
const signers=[Wallet.createRandom().address,Wallet.createRandom().address,Wallet.createRandom().address];

test("the dev manifest combines the owner with the runtime's published keys and stays inside the dev ceilings",()=>{
  const validated=validateDevManifest(devManifestFor(owner.toLowerCase(),runtime,signers.map(item=>item.toLowerCase())));
  assert.equal(validated.governance,owner);
  assert.equal(validated.emergencyCouncil,runtime.emergency);
  assert.deepEqual(validated.approvers,runtime.approvers);
  assert.deepEqual(validated.oracleSigners,signers);
  assert.equal(validated.oracleThreshold,2);
  assert.deepEqual(validated.oracle,{maxDeviationBps:50,maxSkew:5,maxJumpBps:0,jumpWindow:0});
  assert.deepEqual([validated.policy.markets.BTC.impactK,validated.policy.markets.ETH.impactK],[10000,12000]);
  const market={maxTradeUsdc:"50000000",netUsdc:"200000000",grossUsdc:"400000000",sideUsdc:"300000000"};
  assert.equal(devManifestFor(owner,runtime,signers,{makerCapitalUsdc:"200000000",markets:{BTC:market,ETH:market}}).policy.markets.BTC.grossUsdc,"400000000");
  assert.throws(()=>devManifestFor(owner,runtime,signers,{makerCapitalUsdc:"200000000",markets:{BTC:{...market,grossUsdc:"20000000000"},ETH:market}}),/dev ceiling/);
  assert.throws(()=>devManifestFor(runtime.approvers[0],runtime,signers),/distinct/,"the owner cannot double as an approver");
  assert.throws(()=>devManifestFor(owner,runtime,[owner,signers[1],signers[2]]),/distinct/,"the owner cannot double as an oracle signer");
  assert.throws(()=>devManifestFor(owner,runtime,signers.slice(0,2)),/at least 3/);
  const five=[...signers,Wallet.createRandom().address,Wallet.createRandom().address];
  assert.equal(validateDevManifest(devManifestFor(owner,runtime,five)).oracleThreshold,3,"the generated threshold is a majority");
});

test("oracle signers come from RFQ_DEV_ORACLE_SIGNERS or the runtime's published list",()=>{
  assert.deepEqual(oracleSignersFor(runtime,` ${signers.join(" , ").toLowerCase()} `),signers);
  assert.deepEqual(oracleSignersFor({...runtime,oracleSigners:signers},""),signers);
  assert.deepEqual(oracleSignersFor({...runtime,oracleSigners:[owner]},signers.join(",")),signers,"the configured list wins");
  assert.throws(()=>oracleSignersFor(runtime,""),/RFQ_DEV_ORACLE_SIGNERS/);
});

test("confirmation strings match what base-mainnet-cli expects",()=>{
  assert.match(devConfirmation("dev-deploy",owner),new RegExp(`^dev-deploy-8453-${owner.toLowerCase()}-[0-9a-f]{12}$`));
  const record={contracts:{clearingProxy:"0xAbCdEf0123456789aBCdef0123456789AbCdEf01"}} as Parameters<typeof devConfirmation>[2];
  assert.equal(devConfirmation("dev-configure",owner,record),`dev-configure-8453-${owner.toLowerCase()}-abcdef01`);
});
