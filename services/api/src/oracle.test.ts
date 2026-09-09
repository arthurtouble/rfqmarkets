import assert from "node:assert/strict";
import { test } from "node:test";
import { AbiCoder } from "ethers";
import { ChainlinkDataStreamsSource } from "./oracle.js";

const feedId=`0x0003${"11".repeat(30)}`;
function report(observedAt=1_800_000_000){
  const coder=AbiCoder.defaultAbiCoder(),blob=coder.encode(["bytes32","uint32","uint32","uint192","uint192","uint32","int192","int192","int192"],[feedId,observedAt-1,observedAt,0,0,observedAt+10,100_000n*10n**8n,99_990n*10n**8n,100_010n*10n**8n]);
  return coder.encode(["bytes32[3]","bytes","bytes32[]","bytes32[]","bytes32"],[[`0x${"00".repeat(32)}`,`0x${"00".repeat(32)}`,`0x${"00".repeat(32)}`],blob,[],[],`0x${"00".repeat(32)}`]);
}

test("normalizes an official Data Streams v3 envelope to USDC decimals",async()=>{
  const fullReport=report(),source=new ChainlinkDataStreamsSource({apiKey:"test",userSecret:"secret",endpoint:"https://data.example",wsEndpoint:"wss://data.example",feedIds:{BTC:feedId,ETH:`0x0003${"22".repeat(30)}`},feedDecimals:{BTC:8,ETH:8},client:{getLatestReport:async()=>({feedID:feedId,fullReport,validFromTimestamp:1_799_999_999,observationsTimestamp:1_800_000_000})}});
  const value=await source.latest("BTC");assert.equal(value.snapshot.bid,99_990n*1_000_000n);assert.equal(value.snapshot.ask,100_010n*1_000_000n);assert.equal(value.snapshot.observedAtMs,1_800_000_000_000);assert.equal(value.report,fullReport);
});

test("rejects mismatched Data Streams response metadata",async()=>{
  const fullReport=report(),source=new ChainlinkDataStreamsSource({apiKey:"test",userSecret:"secret",endpoint:"https://data.example",wsEndpoint:"wss://data.example",feedIds:{BTC:feedId,ETH:`0x0003${"22".repeat(30)}`},feedDecimals:{BTC:8,ETH:8},client:{getLatestReport:async()=>({feedID:feedId,fullReport,validFromTimestamp:1_799_999_999,observationsTimestamp:1})}});
  await assert.rejects(source.latest("BTC"),/metadata mismatch/);
});
