# API overview

The venue's HTTP API is what the trading app uses, and you can use it too: to stream prices, read accounts, and place trades from your own code. Everything is JSON over HTTPS, with Server-Sent Events for streams.

> **Note.** The API serves a development deployment and may change without notice. There are no API keys and no SLA. Be gentle with it.

## Basics

- **Base URL:** `https://dev.rfq-markets.workers.dev`. The API shares the app's origin.
- **Numbers are strings of integers.** USDC amounts and prices use 6 decimals (`"25000000"` is 25 USDC, and a BTC price of `"83111145000"` is 83,111.145 USDC). Sizes in BTC or ETH use 18 decimals. The exceptions are request fields named `amount` and `limitPrice`, which take decimal USDC strings such as `"25"` or `"83000.5"`.
- **Markets** are named by symbol in the API (`"BTC"`, `"ETH"`) and by index on chain (0, 1 and upward). Governance can list new markets at any time, so discover them rather than hard-coding them: `GET /v1/config` returns `marketList`, an array of `{index, symbol, enabled}` in index order.
- **Rates** such as `fundingApr` are scaled so that `1000000000000` (1e12) means 100% a year.
- **Errors** return a non-2xx status with `{"error": "message"}`, sometimes with `"retriable": true`. The messages are listed in [Placing a trade](../trading/placing-a-trade.md#when-a-trade-is-refused).

## Rate limits

Per IP address, the edge allows 600 reads and 120 writes a minute, and returns `429` with `retry-after: 10` beyond that. Quote requests have their own tighter budget. Each IP can hold up to 8 open streams.

## Reading

| Endpoint | Returns |
| --- | --- |
| `GET /v1/config` | Chain id, chain name, a public RPC URL, `clearingAddress` and `tokenAddress`; `marketList`; `marginTiers`, the base margin schedule; and `markets`, each market's `marginScaleBps`, `maxLeverage` and first-band `initialMarginBps` and `maintenanceMarginBps`. |
| `GET /v1/markets` | A snapshot of every market: oracle `bid`, `ask`, `mid` and `observedAtMs`; the spread and its components; `fundingApr` and funding index; the traders' net position (`aggregateBase`); limits (`maxTradeNotional`, `maxMarketNotional`, `operatingMaxTradeNotional`); `riskMode` and whether buys and sells are currently allowed (`canBuy`, `canSell`); and the market's `index`, `marginScaleBps`, `maxLeverage`, `initialMarginBps` and `maintenanceMarginBps`. |
| `GET /v1/markets/stream` | The same snapshot as an SSE stream of `markets` events, sent whenever it changes (at most every 40 ms), with a heartbeat every 15 seconds. |
| `GET /v1/markets/history?market=BTC&limit=300` | Recent one-second mid, bid and ask samples for charts, up to 1,800. Kept in memory only. |
| `GET /v1/candles?market=BTC&interval=1h&limit=300` | Candles of the mid: `time` (bucket start in ms), `open`, `high`, `low`, `close` and `samples`. Intervals are `1m`, `5m`, `15m`, `1h`, `4h` and `1d`; up to 1,000 candles. |
| `GET /v1/account/{address}` | A live account view: collateral, equity, opening equity, unrealized PnL, accrued funding, margin requirements, available margin, leverage, whether it is liquidatable, and each position with its mark, notional, PnL, funding, initial and maintenance margin and estimated liquidation price; plus `marginParameters` for each market. |
| `GET /v1/orders/{address}` | The account's resting orders and their status. Each has a `type` (`limit`, `stop-loss`, `take-profit` or `stop-entry`) and, for stop orders, `triggerPrice`, `triggerAbove`, `slippageBps` and the `pairId` that links a take profit to its stop loss. |
| `GET /v1/protocol` | Paused and resolution flags, and the current leader epoch, approver set version and policy version. |
| `GET /v1/risk` | Venue totals: accounts, total collateral, and each market's long and short open interest. |
| `GET /v1/positions` | Every account with open positions, paginated, from finalized chain data. |
| `GET /v1/activity` | Every contract event, paginated with a cursor. Filter with `kind`, `market` and `finalized=true`. |
| `GET /v1/account/{address}/activity` | The same, for one account. |
| `GET /v1/portfolio/{address}` | Lifetime totals replayed from the chain: realized PnL, fees, funding, liquidation penalties and `netPnl`; deposits, withdrawals and collateral; volume and trade count; and each position's size and entry. |
| `GET /v1/portfolio/{address}/history?interval=1d` | The same totals as a time series, one point per event, hour (`1h`) or day (`1d`), up to 2,000 points. |
| `GET /v1/portfolio/{address}/trades` | Every fill, newest first, with price, fee, the position before and after, and the realized PnL of each. Paginated with `cursor`; filter with `market`. |
| `GET /v1/funding/{address}` | Every funding settlement on the account, with the amount and a running total. Paginated like trades. |
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

`amount` is the USDC notional. The response includes a `quoteId`, the exact `baseDelta` in 18-decimal units, `expectedPrice`, `worstPrice`, `fee`, `impactCharge`, the spread breakdown and `expiresAtMs`. A quote lives about 10 seconds.

`worstPrice` is your price protection, and becomes the limit price you sign. By default it is 8 bps beyond `expectedPrice`. Add `"slippageBps"`, an integer from 1 to 500, to choose your own: a wider band fails less often in a fast market, at the cost of a worse possible fill.

To close a position, use `POST /v1/close/quote` with `{"account", "market"}` instead. It quotes the exact opposite of the position and is always reduce-only. Add `"fraction"`, in basis points of the position from 1 to 10,000, to close part of it: `5000` closes half. Closes are not limited by the per-trade cap. `POST /v1/close/all/quote` with `{"account"}` returns one close quote per open position; prepare, sign and approve each one as below.

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

## Stop orders

> **Note.** The two endpoints below exist in the venue's API, but the public dev endpoint does not accept them yet, and neither does `POST /v1/close/all/quote`. They return `404 route_not_allowed` until they are opened.

| Step | Endpoint |
| --- | --- |
| Prepare a single order | `POST /v1/orders/trigger/prepare` with `{account, market, kind, side, sizing, amount, triggerPrice, slippageBps, durationSeconds, nonce}`. `kind` is `stop-loss`, `take-profit` or `stop-entry`. `sizing` is `amount` (with `side` and a USDC `amount` at the trigger price) or `position` (the whole current position). `slippageBps` is 1 to 500, default 100. |
| Prepare a pair | `POST /v1/orders/tpsl/prepare` with `{account, market, takeProfitPrice, stopLossPrice, slippageBps, durationSeconds, nonce}`. Either price may be left out. Both legs share one nonce, and the response groups them under a `pairId`. |
| Place | Sign each returned *TriggeredTradeIntent*, then `POST /v1/orders` with `{orderId, userSignature}` for each. |
| Cancel | As for limit orders. Cancelling one leg of a pair cancels both, and the response lists every `cancelledOrderIds`. |

Stop loss and take profit are always reduce-only, and need an open position to reduce. A trigger that is already met when you prepare it is refused with `409`. [Stop loss and take profit](../trading/stop-orders.md) explains how they fire.

## Sponsored account actions

Withdrawals, nonce cancellations, one-click trading grants and paused closes follow the same two-step pattern: `prepare` returns `{domain, types, intent}` (or `grant`), you sign it, and `execute` submits it with the venue paying gas. Prepared messages expire after two minutes.

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
