// Runs the RFQ Markets MCP server on stdio: `npm run mcp`. Configuration comes from the environment:
//   RFQ_API_URL             API origin (default the dev deployment)
//   RFQ_PRIVATE_KEY         the agent's wallet key; without it only prices and quotes are offered
//   RFQ_MCP_MAX_STAKE       largest stake per bet in dollars (default 100)
//   RFQ_MCP_MAX_MULTIPLIER  highest multiplier (default 10)
// The key never leaves this process: the API prepares typed data and the server signs it locally.

import { pathToFileURL } from "node:url";
import { Wallet } from "ethers";
import { RfqClient } from "../../sdk/src/client.js";
import { serve, type ServerInfo } from "./protocol.js";
import { DEFAULT_LIMITS, accountTools, readTools, type Limits } from "./tools.js";

export const DEFAULT_API_URL = "https://dev.rfq-markets.workers.dev";

function limit(env: NodeJS.ProcessEnv, key: string, fallback: number) {
  const raw = env[key];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${key} must be a positive number`);
  return value;
}

export function limitsFrom(env: NodeJS.ProcessEnv): Limits {
  return {
    maxStake: limit(env, "RFQ_MCP_MAX_STAKE", DEFAULT_LIMITS.maxStake),
    maxMultiplier: limit(env, "RFQ_MCP_MAX_MULTIPLIER", DEFAULT_LIMITS.maxMultiplier),
  };
}

export function serverFrom(env: NodeJS.ProcessEnv) {
  const key = env.RFQ_PRIVATE_KEY?.trim();
  const signer = key ? new Wallet(key) : undefined;
  const client = new RfqClient({ baseUrl: env.RFQ_API_URL || DEFAULT_API_URL, signer });
  const tools = signer ? [...readTools(client), ...accountTools(client, limitsFrom(env))] : readTools(client);
  const info: ServerInfo = {
    name: "rfq-markets",
    version: "0.1.0",
    instructions: signer
      ? `Trades RFQ Markets perpetuals as simple up / down bets from wallet ${signer.address}. Bets have no expiry; close them whenever. There are no trading fees. Amounts are US dollars (USDC).`
      : "Reads RFQ Markets prices and quotes. Set RFQ_PRIVATE_KEY to trade.",
  };
  return { info, tools };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { info, tools } = serverFrom(process.env);
  void serve(info, tools, process.stdin, process.stdout);
}
