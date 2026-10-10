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

Base USDC deposits are gas-free where the wallet allows it: the API prepares USDC's EIP-3009 `ReceiveWithAuthorization` naming the clearing contract as receiver (`POST /v1/deposit/prepare`), the app checks it (`apps/web/src/wallet/verify-deposit.ts`), the wallet signs it, and the API recovers the signer, simulates and sponsors `depositWithAuthorization` (`POST /v1/deposit/execute`, `services/api/src/deposits.ts`). USDC lets only the `to` address redeem the authorization, so a signature can only ever credit its signer. Sponsored deposits start at 1 USDC and share the per-account sponsored-action budget. Smart wallets cannot produce the plain signature USDC's `(v, r, s)` form takes, so they (and deposits under 1 USDC) use approve then `deposit(amount)` from the wallet (`apps/web/src/data/actions.tsx`). `apps/web/src/lib/funds.ts` mirrors the contract's limits (10 USDC first-deposit floor, free margin for withdrawals) so the sheet explains a problem before the wallet or contract rejects it. Withdrawals are owner-signed `WithdrawalIntent`s the API sponsors (`/v1/withdraw/prepare` and `/execute`).

The local stack funds wallets with `POST /v1/dev/fund` (mock USDC, deposited or left in the wallet with gas). It is registered only when development funding is on, which the API accepts solely for chain 31337 on a loopback RPC. An earlier simulated cross-chain route API (`/v1/deposit/quote`, `DepositIntent`) was removed: it never moved real funds.

## Deposits from other networks (LI.FI)

When the app settles on Base, the deposit sheet's "From" picker offers any asset on Ethereum, Arbitrum, Optimism, Polygon, BNB Chain, Avalanche or Base. It lists what the wallet holds from LI.FI's balance index, with each network's native asset, USDC and USDT always available. The browser asks LI.FI's REST API (`li.quest/v1/quote`, `order=FASTEST`, `allowDestinationCall=false`) for a route that delivers Base USDC to the user's own wallet, and shows the amount received and the minimum, the rate, bridge and LI.FI fees, source-chain gas, the arrival time and the bridge used before the user confirms (`apps/web/src/lib/bridge.ts`, `trade/FundsDialog.tsx`).

`checkRoute` refuses a quote unless its source and destination chains, tokens, amount, sender and recipient match the request, the router and approval spender are LI.FI's `LiFiDiamond` (`0x1231…4EaE`), and the transaction value matches. Routes losing more than 5% to fees and price impact are refused, and above 1% the sheet warns. The quote is fetched again just before sending and refused if its minimum dropped by more than 1%. The wallet approves the exact amount and sends on the source network, paying that network's gas. The app then follows `li.quest/v1/status` (kept across reloads). When the USDC lands, the sheet reopens with that amount for the gas-free deposit above, so the user never needs ETH on Base.

Not yet done: a destination contract call that delivers and deposits in one step (needs an audited `depositFor` path), cross-chain withdrawals, a LI.FI API key for higher rate limits (keyless use allows about 75 quotes per two hours per IP), and an integrator fee (zero today; LI.FI keeps its own 0.25%).

Primary references:

- LI.FI SDK route request and execution: <https://docs.li.fi/sdk/request-routes> and <https://docs.li.fi/sdk/execute-routes>
- LI.FI integration overview and route-selection guidance: <https://docs.li.fi/sdk/overview> and <https://docs.li.fi/agents/quick-start/decision-tables>
- Socket developer documentation: <https://docs.socket.tech/>

## Lifecycle and recovery (planned)

1. The client requests a route for a receiving account and explicit source terms.
2. The API returns expected and minimum Base USDC plus a short-lived typed intent.
3. The wallet signs the intent. A live adapter then requests the source-chain transaction from the wallet; the API cannot spend source funds.
4. Route status is tracked by its stable route ID and source transaction hash. Retries return the same result.
5. The destination transaction is journaled before waiting for confirmation. API restart reloads quoted, authorized and completed routes.
6. The UI reports progress from source inclusion through destination inclusion. Clearing collateral is updated only from the destination-chain contract state/event.
7. Reorg reconciliation can move a submitted route back to pending. A completed clearing deposit is idempotent because the USDC authorization nonce and the route record cannot be reused.
