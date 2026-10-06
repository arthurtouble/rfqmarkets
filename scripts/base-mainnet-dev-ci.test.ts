import assert from "node:assert/strict";
import test from "node:test";
import { HDNodeWallet, Mnemonic } from "ethers";
import { PYTH_CORE_BASE_MAINNET, devConfirmation, devManifestFor, deriveDevIdentities } from "./base-mainnet-dev-ci.js";
import { validateDevManifest } from "./mainnet-manifest.js";

const phrase="test test test test test test test test test test test junk";

test("dev roles derive from one phrase, with the owner as the wallet's first account",()=>{
  const identities=deriveDevIdentities(phrase),first=HDNodeWallet.fromMnemonic(Mnemonic.fromPhrase(phrase),"m/44'/60'/0'/0/0");
  assert.equal(identities.owner.address,first.address);
  const addresses=[identities.owner,identities.emergency,...identities.approvers,identities.sponsor].map(item=>item.address);
  assert.equal(new Set(addresses).size,6);
  assert.deepEqual(deriveDevIdentities(` ${phrase}\n`),identities);
});

test("the derived dev manifest validates and keeps policy overrides inside the dev ceilings",()=>{
  const identities=deriveDevIdentities(phrase),manifest=devManifestFor(identities,PYTH_CORE_BASE_MAINNET);
  const validated=validateDevManifest(manifest);
  assert.equal(validated.governance,identities.owner.address);
  assert.deepEqual(validated.approvers,identities.approvers.map(item=>item.address));
  const market={maxTradeUsdc:"50000000",netUsdc:"200000000",grossUsdc:"400000000",sideUsdc:"300000000"};
  assert.equal(devManifestFor(identities,PYTH_CORE_BASE_MAINNET,{makerCapitalUsdc:"200000000",markets:{BTC:market,ETH:market}}).policy.markets.BTC.grossUsdc,"400000000");
  assert.throws(()=>devManifestFor(identities,PYTH_CORE_BASE_MAINNET,{makerCapitalUsdc:"200000000",markets:{BTC:{...market,grossUsdc:"20000000000"},ETH:market}}),/dev ceiling/);
});

test("confirmation strings match what base-mainnet-cli expects",()=>{
  const owner=deriveDevIdentities(phrase).owner.address;
  assert.match(devConfirmation("dev-deploy",owner),new RegExp(`^dev-deploy-8453-${owner.toLowerCase()}-[0-9a-f]{12}$`));
  const record={contracts:{clearingProxy:"0xAbCdEf0123456789aBCdef0123456789AbCdEf01"}} as Parameters<typeof devConfirmation>[2];
  assert.equal(devConfirmation("dev-configure",owner,record),`dev-configure-8453-${owner.toLowerCase()}-abcdef01`);
});
