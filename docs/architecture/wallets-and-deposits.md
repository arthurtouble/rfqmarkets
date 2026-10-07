# Wallet and cross-chain deposit design

## Wallet boundary

The frontend consumes a small trader interface (`apps/web/src/wallet/trader.tsx`): connect an account, switch to the settlement chain from `GET /v1/config`, sign typed data and send transactions. The local stack's funded dev key implements the same interface, so every screen works the same with either.

Wallets connect through wagmi 3 with our own connect sheet (`ConnectDialog.tsx`), in the style of RainbowKit, which only supports wagmi 2:

- **Installed extensions** found through EIP-6963, each listed by name.
- **Base Account**, Coinbase's passkey smart wallet, on Base networks only.
- **WalletConnect** for phone and QR wallets, using the public Reown project id in `apps/web/src/lib/env.ts`.

The Base Account and WalletConnect SDKs are loaded only when picked, or on reload when one was the last wallet used (`lazyConnector` in `chain.ts`). No hosted-wallet provider (Privy, Dynamic) is used, and the protocol never accepts a provider's identity as authority: the recovered EVM signature, or ERC-1271 for smart wallets, and the on-chain account remain authoritative.

One-click trading is a contract session key (`grantSessionWithSignature`), generated in the tab and held only in memory (`quick-session.ts`). The grant is sponsored; revoking it is the owner's own transaction (`revokeSession`), so a wallet with no ETH cannot revoke until the grant expires. Disconnecting drops the key from the tab.

## Deposit invariant

A bridge or route API response never creates protocol collateral. Collateral exists only after Base USDC has arrived and the clearing contract has emitted its deposit event. The account view reads clearing state directly until a reorg-aware indexer is available.

The signed `DepositIntent` binds the beneficiary, route identifier, source chain, source token hash, source amount, minimum Base USDC, deadline and nonce. This stops the API, route provider or sponsor from changing the destination account or economic bounds after wallet approval. The local simulator verifies that signature and uses the same sponsored destination-deposit boundary.

## Production route adapter

Use an internal adapter interface with LI.FI as the first implementation candidate. LI.FI exposes quote/route APIs, route execution and status tracking, and lets callers constrain exchanges and bridges. Socket remains a candidate after its current developer interface and production controls are evaluated against the same adapter.

The adapter must pin Base as the destination chain and the canonical Base USDC contract as the destination token. It must enforce an allowlist of reviewed bridges and exchanges, maximum price impact, minimum output, route expiry and per-route/per-user value limits. A destination contract call may combine delivery and deposit only after its exact calldata, attribution, failure behavior and refund path are audited. The safer initial release delivers USDC to the user's Base account, then uses a separately signed EIP-3009 authorization for a gas-sponsored clearing deposit.

Primary references:

- LI.FI SDK route request and execution: <https://docs.li.fi/sdk/request-routes> and <https://docs.li.fi/sdk/execute-routes>
- LI.FI integration overview and route-selection guidance: <https://docs.li.fi/sdk/overview> and <https://docs.li.fi/agents/quick-start/decision-tables>
- Socket developer documentation: <https://docs.socket.tech/>

## Lifecycle and recovery

1. The client requests a route for a receiving account and explicit source terms.
2. The API returns expected and minimum Base USDC plus a short-lived typed intent.
3. The wallet signs the intent. A live adapter then requests the source-chain transaction from the wallet; the API cannot spend source funds.
4. Route status is tracked by its stable route ID and source transaction hash. Retries return the same result.
5. The destination transaction is journaled before waiting for confirmation. API restart reloads quoted, authorized and completed routes.
6. The UI reports progress from source inclusion through destination inclusion. Clearing collateral is updated only from the destination-chain contract state/event.
7. Reorg reconciliation can move a submitted route back to pending. A completed clearing deposit is idempotent because the USDC authorization nonce and the route record cannot be reused.

The executable local adapter is intentionally a simulator: it applies deterministic conversion and routing costs, mints mock USDC and invokes the real clearing deposit. It does not simulate bridge security, source-chain allowance behavior, cross-chain finality or refunds.
