# AI agents

RFQ Markets has a Model Context Protocol (MCP) server, so an AI agent such as Claude can check prices and place Up / Down bets for you. You talk to the agent in plain words ("Put $10 on ETH going up at 3×", "How are my bets doing?", "Close half my SOL bet") and it calls the server's tools.

## What the agent can do

| Tool | What it does |
| --- | --- |
| `list_markets` | Lists the open markets with their price and highest multiplier |
| `get_price` | Gives one market's price, and the prices an up bet buys at and a down bet sells at |
| `quote_bet` | Prices a bet without placing it |
| `get_account` | Shows your balance, what is free for new bets, and each open bet with its result |
| `open_bet` | Bets a stake at a multiplier on a market going up or down |
| `close_bet` | Cashes out a bet, all of it or a percentage |
| `close_all` | Cashes out every bet |
| `protect_bet` | Sets a take-profit price, a stop-loss price or both |

Bets work exactly as in the app: no expiry, no trading fees, and a position of stake × multiplier.

## Your key stays with you

The server runs on your own computer, next to the agent. When the agent places a bet, the API prepares the trade, the server signs it with your wallet key locally, and the approvers and the clearing contract check it like any other trade (see [Signing](signing.md)). The key is never sent anywhere.

Without a key the server only offers the price and quote tools. With one, it refuses any bet above its stake and multiplier limits before signing (100 dollars and 10× unless you set lower or higher ones), on top of the venue's own limits. Use a separate wallet holding only what you are happy for the agent to trade with.

## Setting it up

The server ships with the RFQ Markets source code in `packages/mcp`; its README has the full setup for Claude Code, Claude Desktop and other MCP clients. In short, add a server that runs `npx tsx packages/mcp/src/main.ts` with `RFQ_PRIVATE_KEY` set to the agent wallet's key, and optionally `RFQ_MCP_MAX_STAKE` and `RFQ_MCP_MAX_MULTIPLIER`.

Prefer to write your own bot? The [API](api.md) page covers the same flow over HTTP.
