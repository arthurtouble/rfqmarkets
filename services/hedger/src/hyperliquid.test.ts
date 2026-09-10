import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HyperliquidVenue } from "./hyperliquid.js";

test("Hyperliquid venue speaks the private bridge protocol without exposing the signer in requests",async()=>{
  const directory=mkdtempSync(join(tmpdir(),"rfq-hyperliquid-")),bridge=join(directory,"bridge.py");
  writeFileSync(bridge,`import json, os, sys
for line in sys.stdin:
 r=json.loads(line); m=r["method"]; p=r.get("params",{})
 if m=="verify": out={"accountAddress":os.environ["RFQ_HYPERLIQUID_ACCOUNT_ADDRESS"],"agentAddress":"0x"+"22"*20,"agentName":os.environ["RFQ_HYPERLIQUID_AGENT_NAME"],"validUntil":999,"perpAccountValue":"1000","usablePerpUsdc":"1000","spotUsdc":"0"}
 elif m=="position": out={"base":"1250000000000000000" if p["market"]=="BTC" else "0"}
 elif m=="find": out=None
 elif m=="submit": out={"venueOrderId":"42","status":"filled","filledBase":p["baseDelta"]}
 elif m=="close": out={"closed":True}
 else: raise Exception("bad method")
 print(json.dumps({"id":r["id"],"ok":True,"result":out}),flush=True)
 if m=="close": break
`);
  const venue=new HyperliquidVenue({accountAddress:`0x${"11".repeat(20)}`,agentPrivateKey:`0x${"33".repeat(32)}`,agentName:"test-agent",pythonPath:"python3",bridgePath:bridge,requestTimeoutMs:2_000});
  try{
    assert.equal((await venue.verify()).agentName,"test-agent");assert.equal(await venue.position("BTC"),1_250_000_000_000_000_000n);assert.equal(await venue.find(`0x${"44".repeat(32)}`),null);
    assert.deepEqual(await venue.submit({clientId:`0x${"55".repeat(32)}`,market:"ETH",baseDelta:-2_000_000_000_000_000_000n,limitPrice:3_000_000_000n}),{venueOrderId:"42",status:"filled",filledBase:-2_000_000_000_000_000_000n});
  }finally{await venue.close();rmSync(directory,{recursive:true,force:true});}
});

test("Hyperliquid venue rejects malformed credentials before starting a child",()=>{
  assert.throws(()=>new HyperliquidVenue({accountAddress:"bad",agentPrivateKey:`0x${"33".repeat(32)}`}),/account/);
  assert.throws(()=>new HyperliquidVenue({accountAddress:`0x${"11".repeat(20)}`,agentPrivateKey:"bad"}),/private key/);
  assert.throws(()=>new HyperliquidVenue({accountAddress:`0x${"11".repeat(20)}`,agentPrivateKey:`0x${"33".repeat(32)}`,minimumPerpUsdc:"-1"}),/minimum/);
});
