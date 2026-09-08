# Local application prototype

The local slice contains a long-running Hardhat OP-compatible chain, a deployed UUPS clearing proxy, mock USDC and oracle, one Fastify API leader, three isolated approver instances, a chain-derived indexer, an idempotent hedge worker and a small React/Vite trade and deposit ticket. Signed deposits and orders are gas-sponsored and settle on the local chain.

Compile and start the chain in the first terminal:

```bash
npm run compile:contracts
npm run dev:chain
```

Deploy the local contracts in a second terminal:

```bash
npm run deploy:local
```

Run the services:

```bash
npm run dev:services
```

In another terminal, run the interface:

```bash
npm run dev:web
```

Run the separate hedge operations dashboard in one more terminal:

```bash
npm run dev:admin
```

Open the trading interface at `http://127.0.0.1:4173` and the private hedge dashboard at `http://127.0.0.1:4174`. JSON-RPC listens on `127.0.0.1:8545`, the API on `127.0.0.1:4100`, approvers on loopback ports 4201–4203, the indexer on `127.0.0.1:4300`, and the hedge worker on `127.0.0.1:4400`. Deployment addresses, local-only keys and journals live under the gitignored `.local-state/` directory. Restarting services reconciles signed sender transactions, canonical indexed blocks and idempotent hedge orders. Restarting the Hardhat chain requires a fresh `npm run deploy:local` before services restart.

With the services running, exercise the real HTTP signature path using an ephemeral local EOA. The smoke test signs and settles a simulated Ethereum-to-Base deposit before trading against that collateral:

```bash
npm run smoke:local
```

## Current request path

1. `POST /v1/quote` validates market, side and amount, then builds a thirty-second bounded quote from mock BTC/ETH prices. The browser refreshes the displayed estimate every second.
2. The quote engine calculates base spread, explicit fee and cumulative BTC/ETH inventory impact with integer arithmetic. It reduces all pending commitments, regardless of wallet, into conservative BTC/ETH exposure bounds and checks the four boundary portfolios in linear time.
3. `POST /v1/prepare` generates the contract's complete EIP-712 `TradeIntent`: account, market, signed base size, automatic price/fee limits, random frontend nonce, deadline, leader epoch, policy version and reduce-only flag. Each quote pins the epoch, signer-set version and policy version from one chain block. The user only approves this generated wallet prompt unless quick trading is active.
4. `POST /v1/approve` verifies that the typed signature belongs to the stated account before reserving any shared portfolio capacity. An unsigned or incorrectly signed request cannot move subsequent prices.
5. The API constructs the contract-shaped `MakerApproval` and queries all three approvers in parallel. Each approver pins its own RPC, chain ID and clearing address; reads a block-consistent on-chain epoch, signer membership, pause state, market state and exposure snapshot; independently checks the report against chain time and recomputes the current-state impact floor; verifies the user and exact intent/quote binding; commits its signature to SQLite WAL; and only then responds.
6. The API verifies every returned signature cryptographically, rejects signer-name spoofing, de-duplicates signer addresses and succeeds with two valid responses. One unavailable approver does not interrupt the flow.
7. The deposit panel accepts a source chain, token and amount. `/v1/deposit/quote` returns deterministic local route economics and a `DepositIntent` binding the beneficiary, source terms, minimum Base USDC, expiry and nonce. `/v1/deposit/execute` verifies the wallet signature, journals submission and invokes the real clearing deposit through the gas sponsor. This is a local simulator, not a live bridge.
8. The durable sponsor serializes nonce allocation, signs the complete raw transaction and journals it before broadcast. A retry rebroadcasts the identical hash; inclusion records its canonical block hash, and startup reconciliation detects a missing/reorganized receipt.
9. The indexer follows clearing events, records block hashes and exposes account, global activity, open-position, protocol and finalized exposure endpoints. The public Markets page reads finalized aggregate risk, pseudonymous open positions and trade history from this disposable projection. The trading ticket reads the connected account projection and falls back to direct API chain reads while it catches up.
10. The hedge worker reads finalized aggregate exposure only. Outside its configured band it writes a stable client order ID before sending a capped marketable-limit order to the local venue adapter. Repeated ticks and restarts reconcile the same order instead of duplicating it.
11. Before each quote, the API refreshes settled aggregate exposure from the clearing contract. Signed commitments and deposit routes are written to the API SQLite WAL. Still-executable reservations and completed deposit identities reload after an API restart.
12. Withdrawals, nonce cancellations, session grants and paused-market closes use separate exact EIP-712 messages. The API verifies the owner signature before spending sponsor gas; the contract independently verifies it and consumes the shared nonce. A session is limited on-chain by market, single and cumulative notional, fee and expiry and has no withdrawal authority. Each fresh local deployment receives an isolated runtime journal directory so stale sender or hedge state cannot cross deployments.

The browser's Trade page shows market, amount, Buy/Sell, estimated price, maximum fee and generated price protection. With an injected EIP-1193 wallet, clicking Buy/Sell connects when necessary, signs the generated intent, obtains two approvals and displays the included transaction. A one-time owner signature may enable the default eight-hour quick-trading session; eligible subsequent trades use its tab-scoped key without wallet popups. The deposit panel signs and settles the local route. Once connected, the collateral card exposes an exact signed, sponsored withdrawal. A conservative full-position close appears only while the protocol is paused. The Markets page shows public finalized aggregate exposure, open wallet positions and recent trades. The embedded Codex browser has no injected wallet and reports that clearly.

## Security boundary still missing

Approvers now sign the contract's exact EIP-712 field layout and independently verify live contract state and the API's report against their pinned RPC. Before testnet, give each signer a genuinely independent RPC and oracle transport, require cross-source divergence checks and add full `eth_call` settlement simulation after both candidate signatures are available.

The API journal now holds commitments plus signed-before-broadcast raw sender transactions; it does not duplicate customer balances. Automatic stuck-transaction fee replacement and on-chain leader promotion remain to be implemented. The local indexer is replaceable chain-derived infrastructure. [INDEXER-DESIGN.md](INDEXER-DESIGN.md) defines its production boundary and the Ponder dependency gate.
