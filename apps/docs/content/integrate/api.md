# API overview

The venue's HTTP API is what the trading app uses, and you can use it too: to stream prices, read accounts, and place trades from your own code. Everything is JSON over HTTPS, with Server-Sent Events for streams.

> **Note.** The API serves a development deployment and may change without notice. There are no API keys and no SLA. Be gentle with it.

## Basics

- **Base URL:** `https://dev.rfq-markets.workers.dev`. The API shares the app's origin.
- **Numbers are strings of integers.** USDC amounts and prices use 6 decimals (`"25000000"` is 25 USDC, and a BTC price of `"83111145000"` is 83,111.145 USDC). Sizes in BTC or ETH use 18 decimals. The exceptions are request fields named `amount` and `limitPrice`, which take decimal USDC strings such as `"25"` or `"83000.5"`.
- **Markets** are named `"BTC"` and `"ETH"` in the API, and numbered 0 and 1 on chain.
- **Rates** such as `fundingApr` are scaled so that `1000000000000` (1e12) means 100% a year.
- **Errors** return a non-2xx status with `{"error": "message"}`, sometimes with `"retriable": true`. The messages are listed in [Placing a trade](../trading/placing-a-trade.md#when-a-trade-is-refused).

## Rate limits

Per IP address, the edge allows 600 reads and 120 writes a minute, and returns `429` with `retry-after: 10` beyond that. Quote requests have their own tighter budget. Each IP can hold up to 8 open streams.

## Reading

| Endpoint | Returns |
| --- | --- |
| `GET /v1/config` | Chain id, chain name, a public RPC URL, `clearingAddress` and `tokenAddress`. |
| `GET /v1/markets` | A snapshot of every market: oracle `bid`, `ask`, `mid` and `observedAtMs`; the spread and its components; `fundingApr` and funding index; the traders' net position (`aggregateBase`); limits (`maxTradeNotional`, `maxMarketNotional`, `operatingMaxTradeNotional`); `riskMode` and whether buys and sells are currently allowed (`canBuy`, `canSell`). |
| `GET /v1/markets/stream` | The same snapshot as an SSE stream of `markets` events, sent whenever it changes (at most every 40 ms), with a heartbeat every 15 seconds. |
| `GET /v1/markets/history?market=BTC&limit=300` | Recent one-second mid, bid and ask samples for charts, up to 1,800. Kept in memory only. |
| `GET /v1/account/{address}` | A live account view: collateral, equity, opening equity, unrealized PnL, accrued funding, margin requirements, available margin, leverage, whether it is liquidatable, and each position with its mark, notional, PnL, funding and estimated liquidation price. |
| `GET /v1/orders/{address}` | The account's limit orders and their status. |
| `GET /v1/protocol` | Paused and resolution flags, and the current leader epoch, approver set version and policy version. |
| `GET /v1/risk` | Venue totals: accounts, total collateral, and each market's long and short open interest. |
| `GET /v1/positions` | Every account with open positions, paginated, from finalized chain data. |
| `GET /v1/activity` | Every contract event, paginated with a cursor. Filter with `kind`, `market` and `finalized=true`. |
| `GET /v1/account/{address}/activity` | The same, for one account. |
| `GET /v1/updates/stream` | SSE: an `indexed` event whenever new blocks are indexed, listing which accounts changed. |
| `GET /health` | The indexer's progress and lag behind the chain head. |

Activity and position endpoints come from an indexer that reads the chain. They mark each event `included` or `finalized` (two blocks deep).

## Trading

A market order is three calls and one signature.

### 1. Quote

```
POST /v1/quote
{"market": "BTC", "side": "buy", "amount": "20"}
```

`amount` is the USDC notional. The response includes a `quoteId`, the exact `baseDelta` in 18-decimal units, `expectedPrice`, `worstPrice` (8 bps beyond), `fee`, `impactCharge`, the spread breakdown and `expiresAtMs`. A quote lives about 10 seconds.

To close a position, use `POST /v1/close/quote` with `{"account", "market"}` instead. It quotes the exact opposite of the position and is always reduce-only.

### 2. Prepare

```
POST /v1/prepare
{"quoteId": "…", "account": "0x…", "nonce": "<random uint256>", "reduceOnly": false}
```

Returns `{domain, types, intent, intentHash}`: the EIP-712 *TradeIntent* to sign, with `limitPrice` set to the quote's worst price, `maxFee` and a deadline 30 seconds ahead. Use a fresh random nonce for every intent; nonces are unordered.

### 3. Sign and approve

Sign `intent` with `domain` and `types` (for example with viem's `signTypedData`), then:

```
POST /v1/approve
{"quoteId": "…", "account": "0x…", "nonce": "…", "reduceOnly": false, "userSignature": "0x…"}
```

The API re-prices, collects two approver signatures, submits the trade and waits for it. The response contains the approval, the transaction hash and block, and your resulting collateral and position. Retrying the same request returns the same result for five minutes, so a timeout can be retried safely.

## Limit orders

| Step | Endpoint |
| --- | --- |
| Prepare | `POST /v1/orders/prepare` with `{account, market, side, amount, limitPrice, durationSeconds, nonce, reduceOnly}`. Duration is 300 seconds to 30 days. Returns an `orderId` and the intent to sign. |
| Place | `POST /v1/orders` with `{orderId, userSignature}`. |
| List | `GET /v1/orders/{address}` |
| Cancel | `POST /v1/orders/{orderId}/cancel/prepare`, sign the returned *CancelIntent*, then `POST /v1/orders/{orderId}/cancel` with `{intent, userSignature}`. Cancellation is on chain. |

## Sponsored account actions

Withdrawals, nonce cancellations, quick-trading grants and paused closes follow the same two-step pattern: `prepare` returns `{domain, types, intent}` (or `grant`), you sign it, and `execute` submits it with the venue paying gas. Prepared messages expire after two minutes.

| Action | Prepare body |
| --- | --- |
| `/v1/withdraw/prepare` → `/v1/withdraw/execute` | `{account, nonce, amount}` |
| `/v1/nonce/cancel/prepare` → `/v1/nonce/cancel/execute` | `{account, nonce}` |
| `/v1/session/prepare` → `/v1/session/execute` | `{account, nonce, session, marketMask, maxTradeAmount, maxCumulativeAmount, maxFee, durationSeconds}` |
| `/v1/close/prepare` → `/v1/close/execute` | `{account, nonce, market}`; only while trading is paused |

`execute` takes `{intent, userSignature}` (or `{grant, userSignature}` for sessions).

Deposits are not relayed. Approve the clearing contract for the exact amount and call `deposit(amount)` from the account yourself.

## Signing with a session key

If your account has granted a session (see [Signing](signing.md#sessiongrant)), sign the *TradeIntent* with the session key instead of the account key. The `account` field stays the account's address. Session signatures must be plain ECDSA.

## Going direct

Everything the API does on chain, you can do directly against the contract with your own gas, except obtaining maker approvals: those only come from the approvers, through the API. See [On-chain data](onchain-data.md).
