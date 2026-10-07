# Local application prototype

The local slice contains a long-running Hardhat OP-compatible chain, a deployed transparent clearing proxy and governance-owned ProxyAdmin, mock USDC and oracle, Coinbase public market data, one Fastify API leader, three isolated approver processes, a chain-derived indexer, an idempotent hedge worker and a React trade interface. Signed deposits and orders are gas-sponsored and settle on the local chain.

## Quick start

One command compiles the contracts, starts the chain, deploys v1 and runs every service. It needs no internet access, so it works the same in a fresh cloud session:

```bash
npm run dev:stack            # add -- --web for the trade UI, -- --coinbase for live Coinbase prices
npm run dev:scenario         # in a second terminal: scripted end-to-end scenarios
```

By default prices come from an offline random walk around BTC 100,000 and ETH 4,000. To script a move, such as a crash before a liquidation, post to the loopback price control:

```bash
curl -s 127.0.0.1:4600/price -d '{"market":"BTC","price":85000}'
```

Ctrl-C stops everything. Each run deploys a fresh chain, so no state carries over. Chain logs go to `.local-state/chain.log`. For contract-only changes, `npm run test:foundry` takes seconds and does not need the stack.

## Manual start

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

Each deployment creates a throwaway browser test wallet, funds it with local ETH and deposits 25,000 mock USDC into clearing. The API exposes that key only when chain ID is 31337, the RPC hostname is loopback and development funding is enabled. The UI loads it automatically, signs the same EIP-712 messages as an injected wallet, and immediately displays account equity, margin, positions, orders and history. These keys are disposable and must never be reused outside the local chain.

The local market-data adapter subscribes to Coinbase Advanced Trade's unauthenticated BTC-USD and ETH-USD ticker channel and consumes its best bid and ask. It maintains a heartbeat subscription, reconnects after failure and falls back to Coinbase Exchange's public ticker REST endpoint when the WebSocket observation is absent or older than 1.5 seconds. The API fails closed if neither transport produces a fresh observation. The adapter encodes those prices into the mock oracle's contract report. This exercises the full report/approval/settlement path but does not claim Coinbase data is a production oracle; external deployments use contract-verifiable Pyth Core or Chainlink Data Streams reports.

The Base Sepolia path now uses authenticated Pyth Core data instead. After sourcing the ignored `base-sepolia.env`, run `npm run dev:testnet-services` to start the API, three approvers, indexer, simulated hedge worker and SSE gateway against the deployed contracts. Pyth's signed BTC/ETH bundles arrive at the API over authenticated SSE and remain usable after an authenticated REST recovery fetch. Use `npm run smoke:base-sepolia-pyth` for oracle-only verification and `npm run smoke:base-sepolia-e2e` for a real 1 USDC testnet RFQ.

With the services running, exercise the real HTTP signature path using an ephemeral local EOA. The smoke test signs and settles a simulated Ethereum-to-Base deposit before trading against that collateral:

```bash
npm run smoke:local
npm run smoke:live-market
npm run smoke:quote-load
```

## Current request path

1. `POST /v1/quote` validates market, side and amount, then builds a thirty-second bounded quote from the latest Coinbase bid or ask. The browser receives public market snapshots four times per second and refreshes its size-specific indicative quote twice per second. Since a stopped local automining chain has no oracle keeper, the development path advances its clock and refreshes an exposed nontraded market only when that stale mark would block portfolio checks; production delegates this to independent keepers.
2. The quote engine calculates base spread, explicit fee and cumulative BTC/ETH inventory impact with integer arithmetic. It reduces all pending commitments, regardless of wallet, into conservative BTC/ETH exposure bounds and checks the four boundary portfolios in linear time.
3. `POST /v1/prepare` generates the contract's complete EIP-712 `TradeIntent`: account, market, signed base size, automatic price/fee limits, random frontend nonce, deadline, leader epoch, policy version and reduce-only flag. Each quote pins the epoch, signer-set version and policy version from one chain block and becomes bound to the first account and nonce that prepares it. An exact retry remains idempotent; another wallet or nonce cannot reuse the same favorable quote.
4. `POST /v1/approve` requires that exact prepared account and nonce, then verifies that the typed signature belongs to the stated EOA, an ERC-1271 account at the pinned block, or a valid limited session before reserving any shared portfolio capacity. An unsigned or incorrectly signed request cannot move subsequent prices.
5. The API constructs the contract-shaped `MakerApproval` and queries all three approvers in parallel. Each approver pins its own RPC, chain ID and clearing address; compares the pinned block hash with its configured secondary RPC; reads a block-consistent on-chain epoch, signer membership, pause state, market state and exposure snapshot; independently checks the report against chain time and recomputes the current-state impact floor; verifies the user and exact intent/quote binding; commits its signature to SQLite WAL; and only then responds.
6. The API verifies every returned signature cryptographically, rejects signer-name spoofing, de-duplicates signer addresses and succeeds with two valid responses. One unavailable approver does not interrupt the flow.
7. The deposit panel accepts a source chain, token and amount. `/v1/deposit/quote` returns deterministic local route economics and a `DepositIntent` binding the beneficiary, source terms, minimum Base USDC, expiry and nonce. `/v1/deposit/execute` verifies the wallet signature, journals submission and invokes the real clearing deposit through the gas sponsor. This is a local simulator, not a live bridge.
8. The durable sponsor serializes nonce allocation, signs the complete raw transaction and journals it before broadcast. A retry first reconciles every same-nonce attempt; after a bounded wait it can journal and broadcast one 15% fee-bumped replacement. Direct receipt polling avoids false timeouts from delayed provider block events, inclusion records its canonical block hash, and startup reconciliation detects a missing/reorganized receipt.
9. The indexer follows clearing events, records block hashes and exposes account, global activity, open-position, protocol and finalized exposure endpoints. The public Markets page reads finalized aggregate risk, pseudonymous open positions and trade history from this disposable projection. The trading ticket reads the connected account projection and falls back to direct API chain reads while it catches up.
10. The hedge worker reads finalized aggregate exposure only. Outside its configured band it writes a stable client order ID before sending a capped marketable-limit order to the local venue adapter. Repeated ticks and restarts reconcile the same order instead of duplicating it. Partial fills update venue position before the next slice, and any still-open order blocks additional orders in that market.
11. Before each quote, the API refreshes settled aggregate exposure from the clearing contract. Signed commitments and deposit routes are written to the API SQLite WAL. Still-executable reservations and completed deposit identities reload after an API restart.
12. Withdrawals, nonce cancellations, session grants and paused-market closes use separate exact EIP-712 messages. The API verifies the owner signature before spending sponsor gas; the contract independently verifies it and consumes the shared nonce. A session is limited on-chain by market, single and cumulative notional, fee and expiry and has no withdrawal authority. Each fresh local deployment receives an isolated runtime journal directory so stale sender or hedge state cannot cross deployments.

The Trade page shows Coinbase BBO and feed age, size-specific maker execution, base spread, inventory charge, fee and price protection. A local test wallet loads automatically; an injected EIP-1193 wallet remains the non-development path. Clicking Buy/Sell is single-flight: it disables the ticket while it signs the generated intent, obtains two approvals and displays the included transaction. A one-time owner signature may enable the default eight-hour quick-trading session; eligible subsequent trades use its memory-only, tab-scoped key without wallet popups. Session storage retains only the public session address so a refreshed tab can revoke the grant; it never persists the private key. The same control sends a direct owner revocation and deletes the public metadata only after a successful receipt, so revocation remains available without the API. Account and chain-change wallet events clear stale account state. The deposit panel signs and settles the local route. The account panel always displays equity and margin metrics and provides Positions, Open orders, Trade history and Account history tabs. A conservative full-position close appears only while the protocol is paused. The Markets page shows public finalized aggregate exposure, open wallet positions and recent trades.

## Security boundary still missing

Approvers run as separate loopback-only OS processes, sign the contract's exact EIP-712 field layout and independently verify live contract state and the API's report against their pinned RPC. They fail closed when the configured secondary RPC has a different hash at that height. After assembling two signatures, the API performs a final `eth_call` of the exact transaction, including the adapter-reported oracle verification fee, before journaling and broadcasting it. `npm run smoke:approver-outage` suspends one process and proves the other two still settle, then suspends a second and proves the API fails closed. Production still requires genuinely independent provider, deployment and key-control domains for the signers.

The API journal now holds commitments plus every signed-before-broadcast sender attempt; it does not duplicate customer balances. `npm run smoke:sender-replacement` disables automining, forces a same-nonce fee replacement and proves the replacement is the included attempt. `npm run smoke:failover` advances the expected epoch through the local emergency-council account, proves an old intent is fenced immediately, and settles a fresh quote under the new epoch. A deployed production council/Safe and externally enforced gas-refill budget remain open. The local indexer is replaceable chain-derived infrastructure. [INDEXER-DESIGN.md](INDEXER-DESIGN.md) defines its production boundary and the Ponder dependency gate.
