import assert from "node:assert/strict";
import test from "node:test";
import { Wallet } from "ethers";
import { PYTH_CORE_BASE_MAINNET, devConfirmation, devManifestFor, type RuntimeIdentities } from "./base-mainnet-dev-ci.js";
import { validateDevManifest } from "./mainnet-manifest.js";

const owner=Wallet.createRandom().address,runtime:RuntimeIdentities={emergency:Wallet.createRandom().address,approvers:[Wallet.createRandom().address,Wallet.createRandom().address,Wallet.createRandom().address],sponsor:Wallet.createRandom().address};

test("the dev manifest combines the owner with the runtime's published keys and stays inside the dev ceilings",()=>{
  const validated=validateDevManifest(devManifestFor(owner.toLowerCase(),runtime,PYTH_CORE_BASE_MAINNET));
  assert.equal(validated.governance,owner);
  assert.equal(validated.emergencyCouncil,runtime.emergency);
  assert.deepEqual(validated.approvers,runtime.approvers);
  const market={maxTradeUsdc:"50000000",netUsdc:"200000000",grossUsdc:"400000000",sideUsdc:"300000000"};
  assert.equal(devManifestFor(owner,runtime,PYTH_CORE_BASE_MAINNET,{makerCapitalUsdc:"200000000",markets:{BTC:market,ETH:market}}).policy.markets.BTC.grossUsdc,"400000000");
  assert.throws(()=>devManifestFor(owner,runtime,PYTH_CORE_BASE_MAINNET,{makerCapitalUsdc:"200000000",markets:{BTC:{...market,grossUsdc:"20000000000"},ETH:market}}),/dev ceiling/);
  assert.throws(()=>devManifestFor(runtime.approvers[0],runtime,PYTH_CORE_BASE_MAINNET),/distinct/,"the owner cannot double as an approver");
});

test("confirmation strings match what base-mainnet-cli expects",()=>{
  assert.match(devConfirmation("dev-deploy",owner),new RegExp(`^dev-deploy-8453-${owner.toLowerCase()}-[0-9a-f]{12}$`));
  const record={contracts:{clearingProxy:"0xAbCdEf0123456789aBCdef0123456789AbCdEf01"}} as Parameters<typeof devConfirmation>[2];
  assert.equal(devConfirmation("dev-configure",owner,record),`dev-configure-8453-${owner.toLowerCase()}-abcdef01`);
});
