import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { HyperliquidVenue } from "../services/hedger/src/hyperliquid.js";

type Identity = { address: string; privateKey: string };
const identities = JSON.parse(readFileSync(resolve(".local-state/testnet-identities.json"), "utf8")) as {
  hyperliquidAgent: Identity;
};
const required = (name: string) => {
  const value = process.env[name];
  if (!value || value.startsWith("replace_")) throw new Error(`missing ${name}`);
  return value;
};
const venue = new HyperliquidVenue({
  accountAddress: required("RFQ_HYPERLIQUID_ACCOUNT_ADDRESS"),
  agentPrivateKey: identities.hyperliquidAgent.privateKey,
  agentName: required("RFQ_HYPERLIQUID_AGENT_NAME"),
  apiUrl: process.env.RFQ_HYPERLIQUID_API_URL,
  pythonPath: process.env.RFQ_HYPERLIQUID_PYTHON,
});
try {
  const verification = await venue.verify(),
    [btc, eth] = await Promise.all([venue.position("BTC"), venue.position("ETH")]);
  let signerExercise: unknown = "skipped";
  if (process.argv.includes("--exercise-signer")) {
    const result = await venue.submit({
      clientId: `0x${randomBytes(32).toString("hex")}`,
      market: "BTC",
      baseDelta: 1_000_000_000_000_000n,
      limitPrice: 1_000_000n,
    });
    if (result.status !== "rejected" || result.filledBase !== 0n)
      throw new Error("nonmarketable signer exercise had an unexpected execution");
    signerExercise = { status: result.status, filledBase: result.filledBase.toString() };
  }
  if (process.argv.includes("--exercise-roundtrip")) {
    if (btc !== 0n) throw new Error("BTC position must be flat before the round-trip smoke");
    const mid = async () => {
      const response = await fetch("https://api.hyperliquid-testnet.xyz/info", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: "allMids" }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) throw new Error(`mids ${response.status}`);
      const value = Number(((await response.json()) as Record<string, string>).BTC);
      if (!Number.isFinite(value) || value <= 0) throw new Error("invalid BTC mid");
      return value;
    };
    const clientId = () => `0x${randomBytes(32).toString("hex")}`,
      size = 200_000_000_000_000n;
    const openingMid = await mid(),
      opened = await venue.submit({
        clientId: clientId(),
        market: "BTC",
        baseDelta: size,
        limitPrice: BigInt(Math.floor(openingMid * 1.01 * 1e6)),
      });
    if (opened.status !== "filled" || opened.filledBase <= 0n)
      throw new Error(
        `round-trip open did not fill: ${JSON.stringify({ ...opened, filledBase: opened.filledBase.toString() })}`,
      );
    let remaining = await venue.position("BTC"),
      closed: unknown;
    for (let attempt = 0; remaining !== 0n && attempt < 3; attempt++) {
      const closingMid = await mid(),
        result = await venue.submit({
          clientId: clientId(),
          market: "BTC",
          baseDelta: -remaining,
          limitPrice: BigInt(Math.floor(closingMid * 0.99 * 1e6)),
        });
      closed = { ...result, filledBase: result.filledBase.toString() };
      remaining = await venue.position("BTC");
    }
    if (remaining !== 0n) throw new Error(`round-trip cleanup left BTC position ${remaining}`);
    signerExercise = {
      status: "roundtrip-filled-and-flat",
      opened: { ...opened, filledBase: opened.filledBase.toString() },
      closed,
    };
  }
  console.log(
    JSON.stringify(
      {
        ok: true,
        mode: venue.mode,
        accountAddress: verification.accountAddress,
        agentAddress: verification.agentAddress,
        agentName: verification.agentName,
        validUntil: verification.validUntil,
        perpAccountValue: verification.perpAccountValue,
        usablePerpUsdc: verification.usablePerpUsdc,
        spotUsdc: verification.spotUsdc,
        positions: { BTC: btc.toString(), ETH: eth.toString() },
        signerExercise,
      },
      null,
      2,
    ),
  );
} finally {
  await venue.close();
}
