# Hedging and operations design

## Capital and authority

The hedge account owns separate capital at each venue. It is not customer collateral, Base maker backing or insurance, and the clearing contract gives it no solvency credit until funds actually return to Base. The version 0.1 budget reserves 200,000 USDC for external hedge margin and caps each market's venue position at 100,000 USDC until liquidation and withdrawal behavior are measured.

For Hyperliquid, use a dedicated master subaccount or vault funded for hedging and authorize one named API/agent wallet per active hedge process. Hyperliquid's public Info endpoint can read market and account state without an API password, but order placement uses a signed action sent to the Exchange endpoint. The API wallet is therefore a real secret-bearing private key even though execution is decentralized. It should have no Base, treasury, governance or customer authority and must be separately revocable and replaced during failover.

Hyperliquid recommends one API wallet per trading process because nonces are tracked by signer, and warns against reusing deregistered agent addresses. The local service already follows the required shape: a single writer, atomic client IDs, explicit expiry/slippage, reconciliation before retry and an independently persisted venue position.

Official references:

- [Hyperliquid API overview](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api)
- [Signing](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/signing)
- [Nonces and API wallets](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/nonces-and-api-wallets)
- [Exchange endpoint and client order IDs](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/exchange-endpoint)

## Hedge loop

1. Read a sealed/finalized Base block from the indexer and independently verify the block and aggregate market state through an RPC.
2. Treat the maker's economic exposure as the opposite of aggregate customer base. The venue target is therefore the customer aggregate base: customer long BTC produces a long BTC venue hedge, offsetting the maker's short BTC exposure.
3. Include reconciled venue position, open orders, fills, fees and funding. Never count a requested or ambiguous order as filled. While an order remains open, reserve that market and do not submit another slice.
4. Inside the launch band, leave exposure unchanged. Outside it, trade toward half the band using capped IOC/marketable-limit slices. The local defaults are a 25,000 USDC action band, 25,000 USDC maximum slice and 20 bps limit protection.
5. Write the deterministic client order ID and exact intended order before submission. On timeout, query Hyperliquid by account/order/client ID and reconcile fills before any retry.
6. If chain, indexer, venue or credentials disagree, stop increasing customer exposure. Existing positions remain visible and the API can restrict quotes to exposure-reducing flow.

The local stack now enforces that last rule on both authorization paths. The hedge worker publishes an authenticated loopback-only risk snapshot; it never exposes venue credentials. A gap above the effective hedge threshold halves the market's operating trade limit. A gap above twice that threshold, an unhealthy worker, an unreadable snapshot or a stale snapshot changes the market to reduce-only. The effective threshold is at least the venue's minimum executable order, preventing harmless dust from halting the product. Production defaults require a snapshot no older than three seconds; the public testnet topology uses a ten-second bound to tolerate public-indexer jitter. A recently successful finalized read remains usable only within that bound, while venue and order failures are critical immediately. The API uses the state before creating a firm quote, and every approver reads it independently before signing, so a compromised API cannot bypass the restriction. Reduce-only means the proposed base delta must strictly reduce absolute aggregate exposure; a direction flip of equal size is rejected.

The internal snapshot is deliberately small: health, finalized indexed block, per-market mode, absolute gap notional and configured band. Only the single hedge loop queries the external venue; approver, API and dashboard reads use its last reconciled in-memory snapshot and never queue external account calls. The browser receives only `normal`, `guarded` or `reduce_only`, the effective maximum trade amount and permitted sides as part of its existing shared market stream.

For the selected market, both the API and approvers value existing aggregate base at the oracle mark contained in the proposed settlement report. This matches the contract, which records that report before computing inventory impact. Other-market exposure uses its last verified on-chain mark. Using an older selected-market mark can undercharge an inventory-reducing quote after a large price move, so the full local smoke suite deliberately runs trades across changing live prices.

The current `local-simulator` venue applies fills atomically in SQLite so restart and idempotency behavior can be tested without capital. The worker's `HedgeVenue` boundary exposes position lookup, client-ID reconciliation and order submission with open, partial, filled and rejected outcomes. Tests cover restart, a lost partial-fill acknowledgement, and a permanently open order.

The `hyperliquid-testnet` venue keeps the same durable TypeScript control loop and delegates only Hyperliquid wire formatting, signatures and submission to a persistent private bridge running the pinned official Python SDK. The bridge verifies the named agent-to-master relationship at startup and every minute, converts protocol fixed-point values to venue tick/lot precision, uses IOC marketable-limit orders with a ten-second action expiry, and reconciles by a deterministic 16-byte client order ID. A 250 ms account-state cache lets BTC and ETH share one read without making hedge decisions materially stale. A timeout kills the bridge; the existing `submitted` journal state then forces reconciliation before the next attempt. Venue rejection reasons are journaled and any rejected hedge fails the loop closed. The mode is opt-in through `RFQ_HEDGE_VENUE` and is pinned to the testnet URL. Startup, submissions, and recurring position reads require `activeAssetData.availableToTrade` to meet `RFQ_HYPERLIQUID_MIN_PERP_USDC`; this works for both classic and unified accounts. `RFQ_HEDGE_BAND_USDC` and `RFQ_HEDGE_MAX_ORDER_USDC` keep production defaults at 25,000 USDC while allowing proportionally smaller testnet drills. `RFQ_HEDGE_MIN_ORDER_USDC` prevents invalid dust submissions; when protocol exposure returns inside the band, the worker flattens a larger venue position rather than deliberately leaving an untradeable residual.

The live testnet lifecycle drill uses separate temporary journals and ports, verifies a flat starting state, and requires distinct client and venue order IDs for opening and closing. It fails if either Base or Hyperliquid retains ETH exposure. The first complete pass opened and closed 0.0045 ETH through Hyperliquid orders `59794691146` and `59794704363` after Base transactions `0xe3df31b1e95d754805ca11070a24f32d38d81d514974732458a1eb2ba5961094` and `0x1a69d669cc3a2972481323fc9884b9ee74ee9b0eae152fe9e897d31d35e22144` finalized.

## Visibility boundary

Aggregate customer long/short counts, gross exposure, protocol collateral and general protocol health can be public because they derive from public Base state. Publishing the live venue hedge, open orders, exact thresholds, execution failures or credentials creates avoidable strategy leakage.

The public application should expose only delayed or coarse aggregate protocol risk. The operations dashboard runs as a separate application and queries the loopback/private hedge API. In production it belongs on a private hostname behind device-bound identity or VPN access. It contains no order-entry controls and never receives the API wallet key.

Local endpoints:

- Public/indexer risk: `http://127.0.0.1:4300/v1/risk`
- Private hedge status: `http://127.0.0.1:4400/v1/status`
- Authenticated quote-admission status: `http://127.0.0.1:4400/internal/risk`
- Private dashboard: `http://127.0.0.1:4174`

## Chainlink Data Streams

Data Streams is the intended primary execution oracle. It is pull-based, but authenticated reports are not freely accessible. Chainlink currently requires a self-service account, paid feed subscriptions, feed IDs and HMAC credentials. The public Discovery endpoint can list public streams without authentication. The exact-pinned official TypeScript SDK now handles authenticated REST acquisition, retries and v3 decoding behind the API's `OracleSource` boundary.

Keep the Data Streams secret out of the frontend. The API fetches the report needed for settlement and passes the unmodified signed blob into the clearing call. The deployed Chainlink adapter verifies the report through the configured VerifierProxy and pins feed IDs and decimals. Approvers independently validate the blob, entitlement-independent report fields, freshness, spread and selection policy; for infrastructure isolation they should use separately scoped credentials and separate active-active connections where the subscription permits it.

Official references:

- [Data Streams overview](https://docs.chain.link/data-streams)
- [Account, credentials and subscription requirements](https://docs.chain.link/data-streams/sign-up)
- [HMAC authentication](https://docs.chain.link/data-streams/reference/data-streams-api/authentication)
- [Onchain EVM verification](https://docs.chain.link/data-streams/reference/data-streams-api/onchain-verification)
