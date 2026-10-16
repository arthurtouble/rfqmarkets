// Runs the RFQ Markets MCP server on stdio: `npm run mcp`. Configuration comes from the environment:
//   RFQ_API_URL             API origin (default the dev deployment)
//   RFQ_PRIVATE_KEY         the agent's wallet key; without it only prices and quotes are offered
//   RFQ_ACCOUNT             the account RFQ_PRIVATE_KEY trades for as a session key (granted with the SDK's
//                           `grantSession`); without it the key's own wallet is the account
//   RFQ_CHAIN_ID            chain id every signature is bound to (recommended; else read from the API)
//   RFQ_CLEARING_ADDRESS    clearing contract every signature is bound to (recommended; else read from the API)
//   RFQ_MCP_MAX_STAKE       largest stake per bet in dollars (default 100)
//   RFQ_MCP_MAX_MULTIPLIER  highest multiplier (default 10)
// The key never leaves this process: the API prepares typed data and the server signs it locally.

import { pathToFileURL } from "node:url";
import { Wallet, getAddress } from "ethers";
import { RfqClient } from "../../sdk/src/client.js";
import { serve, type ServerInfo } from "./protocol.js";
import { DEFAULT_LIMITS, accountTools, readTools, type Limits, type Venue } from "./tools.js";

export const DEFAULT_API_URL = "https://dev.rfq-markets.workers.dev";

function limit(env: NodeJS.ProcessEnv, key: string, fallback: number) {
  const raw = env[key];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${key} must be a positive number`);
  return value;
}

/**
 * The settlement every signature is bound to. Pinned, the SDK refuses typed data for any other chain or contract
 * whatever the API returns; unpinned, it trusts the API's `/v1/config`.
 */
export function settlementFrom(env: NodeJS.ProcessEnv): { chainId?: bigint; clearingAddress?: string } {
  const chainId = env.RFQ_CHAIN_ID?.trim(),
    clearing = env.RFQ_CLEARING_ADDRESS?.trim();
  if (chainId && !/^(0x[0-9a-fA-F]+|\d+)$/.test(chainId))
    throw new Error("RFQ_CHAIN_ID must be a chain id such as 8453");
  return {
    ...(chainId ? { chainId: BigInt(chainId) } : {}),
    ...(clearing ? { clearingAddress: getAddress(clearing) } : {}),
  };
}

export function limitsFrom(env: NodeJS.ProcessEnv): Limits {
  return {
    maxStake: limit(env, "RFQ_MCP_MAX_STAKE", DEFAULT_LIMITS.maxStake),
    maxMultiplier: limit(env, "RFQ_MCP_MAX_MULTIPLIER", DEFAULT_LIMITS.maxMultiplier),
  };
}

/**
 * A venue that trades for `account` with a session key: every call names the account, and TP/SL is left out
 * because a session key may only place market orders and closes.
 */
export function sessionVenue(client: RfqClient, account: string): Venue {
  return {
    markets: () => client.markets(),
    quote: (input) => client.quote({ ...input, account }),
    account: (address) => client.account(address ?? account),
    trade: (input) => client.trade({ ...input, account }),
    close: (input) => client.close({ ...input, account }),
    closeAll: (input = {}) => client.closeAll({ ...input, account }),
    tpsl: () => Promise.reject(new Error("a session key cannot set take-profit or stop-loss orders")),
  };
}

export function serverFrom(env: NodeJS.ProcessEnv) {
  const key = env.RFQ_PRIVATE_KEY?.trim(),
    account = env.RFQ_ACCOUNT?.trim() ? getAddress(env.RFQ_ACCOUNT.trim()) : undefined;
  if (account && !key)
    throw new Error("RFQ_ACCOUNT needs RFQ_PRIVATE_KEY, the session key that trades for it");
  const signer = key ? new Wallet(key) : undefined;
  const client = new RfqClient({
    baseUrl: env.RFQ_API_URL || DEFAULT_API_URL,
    signer,
    ...settlementFrom(env),
  });
  const venue = account ? sessionVenue(client, account) : client;
  const tools = signer
    ? [
        ...readTools(venue),
        ...accountTools(venue, limitsFrom(env)).filter((tool) => !account || tool.name !== "protect_bet"),
      ]
    : readTools(client);
  const info: ServerInfo = {
    name: "rfq-markets",
    version: "0.1.0",
    instructions: !signer
      ? "Reads RFQ Markets prices and quotes. Set RFQ_PRIVATE_KEY to trade."
      : `Trades RFQ Markets perpetuals as simple up / down bets from ${
          account
            ? `account ${account} with a session key whose limits the venue enforces`
            : `wallet ${signer.address}`
        }. Bets have no expiry; close them whenever. There are no trading fees. Amounts are US dollars (USDC).`,
  };
  return { info, tools };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { info, tools } = serverFrom(process.env);
  void serve(info, tools, process.stdin, process.stdout);
}
