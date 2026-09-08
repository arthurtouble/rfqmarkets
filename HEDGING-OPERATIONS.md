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
3. Include reconciled venue position, open orders, fills, fees and funding. Never count a requested or ambiguous order as filled.
4. Inside the launch band, leave exposure unchanged. Outside it, trade toward half the band using capped IOC/marketable-limit slices. The local defaults are a 25,000 USDC action band, 25,000 USDC maximum slice and 20 bps limit protection.
5. Write the deterministic client order ID and exact intended order before submission. On timeout, query Hyperliquid by account/order/client ID and reconcile fills before any retry.
6. If chain, indexer, venue or credentials disagree, stop increasing customer exposure. Existing positions remain visible and the API can restrict quotes to exposure-reducing flow.

The current `local-simulator` venue applies fills atomically in SQLite so restart and idempotency behavior can be tested without capital. A live adapter must use the official SDK's signing logic rather than independently recreating Hyperliquid's msgpack signing rules.

## Visibility boundary

Aggregate customer long/short counts, gross exposure, protocol collateral and general protocol health can be public because they derive from public Base state. Publishing the live venue hedge, open orders, exact thresholds, execution failures or credentials creates avoidable strategy leakage.

The public application should expose only delayed or coarse aggregate protocol risk. The operations dashboard runs as a separate application and queries the loopback/private hedge API. In production it belongs on a private hostname behind device-bound identity or VPN access. It contains no order-entry controls and never receives the API wallet key.

Local endpoints:

- Public/indexer risk: `http://127.0.0.1:4300/v1/risk`
- Private hedge status: `http://127.0.0.1:4400/v1/status`
- Private dashboard: `http://127.0.0.1:4174`

## Chainlink Data Streams

Data Streams is the intended primary execution oracle. It is pull-based, but authenticated reports are not freely accessible. Chainlink currently requires a self-service account, paid feed subscriptions, feed IDs and HMAC credentials. The public Discovery endpoint can list public streams without authentication; fetching reports requires the API key, timestamp and HMAC-SHA256 signature.

Keep the Data Streams secret out of the frontend. The API fetches the report needed for settlement and passes the unmodified signed blob into the clearing call. The deployed Chainlink adapter verifies the report through the configured VerifierProxy and pins feed IDs and decimals. Approvers independently validate the blob, entitlement-independent report fields, freshness, spread and selection policy; for infrastructure isolation they should use separately scoped credentials and separate active-active connections where the subscription permits it.

Official references:

- [Data Streams overview](https://docs.chain.link/data-streams)
- [Account, credentials and subscription requirements](https://docs.chain.link/data-streams/sign-up)
- [HMAC authentication](https://docs.chain.link/data-streams/reference/data-streams-api/authentication)
- [Onchain EVM verification](https://docs.chain.link/data-streams/reference/data-streams-api/onchain-verification)
