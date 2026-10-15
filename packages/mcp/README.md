# RFQ Markets MCP server

Lets an AI agent (Claude, or any client that speaks the Model Context Protocol) read prices and place the same
Up / Down bets the app offers. It runs on the agent's machine over stdio, so the wallet key never leaves it: the
API prepares each trade as EIP-712 typed data, the server signs it locally, and the venue's approvers and
contracts check it exactly as they check a trade from the app.

## Tools

| Tool           | What it does                                                                  | Needs a key |
| -------------- | ----------------------------------------------------------------------------- | ----------- |
| `list_markets` | Open markets with the price and the highest multiplier each allows            | No          |
| `get_price`    | One market's mid, and the prices an up bet buys at and a down bet sells at    | No          |
| `quote_bet`    | The price a bet would open at, without placing it                             | No          |
| `get_account`  | Balance, equity, money free for new bets, and open bets with their result     | Yes         |
| `open_bet`     | Bets `stake` × `multiplier` dollars on a market going `up` or `down`          | Yes         |
| `close_bet`    | Cashes out a market's bet, all of it or a `percent`                           | Yes         |
| `close_all`    | Cashes out every open bet                                                     | Yes         |
| `protect_bet`  | Sets a take-profit price, a stop-loss price or both on a market's open bet    | Yes         |

Amounts are plain US dollars (USDC). Bets have no expiry and there are no trading fees; the quoted price
includes the venue's small markup.

## Setup

From a checkout of this repository, after `npm ci`:

```sh
RFQ_PRIVATE_KEY=0x... npm run -s mcp
```

| Variable                 | Meaning                                                              | Default                               |
| ------------------------ | -------------------------------------------------------------------- | ------------------------------------- |
| `RFQ_API_URL`            | API origin                                                           | `https://dev.rfq-markets.workers.dev` |
| `RFQ_PRIVATE_KEY`        | The agent's wallet key. Without it only the read tools are offered.  | none                                  |
| `RFQ_ACCOUNT`            | The account `RFQ_PRIVATE_KEY` trades for as a session key            | the key's own wallet                  |
| `RFQ_MCP_MAX_STAKE`      | Largest stake one bet may put up, in dollars                         | `100`                                 |
| `RFQ_MCP_MAX_MULTIPLIER` | Highest multiplier; a market's own lower cap still applies           | `10`                                  |

Use a dedicated wallet funded with only what the agent may lose. The limits are checked here before anything
is signed, on top of the venue's own per-trade and exposure limits.

Safer still, use a session key. Grant it from the owner wallet with the SDK, then run the server with the
session key and the owner's address:

```ts
const session = Wallet.createRandom(); // keep session.privateKey for the agent
await new RfqClient({ baseUrl, signer: ownerWallet }).grantSession({
  session: session.address,
  marketIndexes: [0, 1], // BTC and ETH
  maxTradeAmount: "50",
  maxCumulativeAmount: "500",
  durationSeconds: 7 * 86_400,
});
```

```sh
RFQ_PRIVATE_KEY=<session key> RFQ_ACCOUNT=<owner address> npm run -s mcp
```

The clearing contract enforces the session's markets, caps and expiry, and a session key can never withdraw,
cancel or grant. `protect_bet` is not offered with a session key, which may only open and close.

### Claude Code

```sh
claude mcp add rfq-markets --env RFQ_PRIVATE_KEY=0x... -- npx tsx /path/to/rfqmarkets/packages/mcp/src/main.ts
```

### Claude Desktop and other clients

Add the server to the client's MCP configuration (for Claude Desktop, `claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "rfq-markets": {
      "command": "npx",
      "args": ["tsx", "/path/to/rfqmarkets/packages/mcp/src/main.ts"],
      "env": { "RFQ_PRIVATE_KEY": "0x...", "RFQ_MCP_MAX_STAKE": "25" }
    }
  }
}
```

Then ask, for example, "What's Bitcoin at?", "Put $10 on ETH going up at 3×" or "Close half my SOL bet".

## How it works

`protocol.ts` is a dependency-free MCP server (JSON-RPC 2.0 over newline-delimited stdio: `initialize`, `ping`,
`tools/list`, `tools/call`). `tools.ts` turns bets into calls on the TypeScript SDK's `RfqClient`
([`packages/sdk`](../sdk/README.md)): an up bet is a market buy of `stake × multiplier` dollars of notional, a
down bet a sell, and closing is a reduce-only fill. Tests: `npm run test:services`.
