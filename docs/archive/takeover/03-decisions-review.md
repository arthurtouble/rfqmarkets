# 3. Key decisions and whether they hold up

The full log of 34 decisions, with sources and how each changed over time, is in [reviews/existing-docs.md §2](reviews/existing-docs.md). This page gives my verdict on the ones that shape the product.

Verdicts: **Keep** (sound), **Keep, fix** (sound idea, implementation gaps), **Revisit** (needs a decision), **Reverse** (I recommend changing it).

## Product and protocol

| Decision | Verdict | Why |
| --- | --- | --- |
| RFQ against a single operator maker, not an order book or third-party makers | **Keep** | Simplest credible design for a small team with ~$1M capital. Size-specific prices, no matching engine. Third-party makers can be added later behind the same approval interface. |
| BTC and ETH only, hard-coded as two storage slots | **Keep for launch, fix before mainnet** | Fine product scope, but `Market[2]` fixed arrays lock the storage layout. Adding SOL or anything else later means a layout-changing upgrade. Since mainnet is greenfield, switch to a `mapping(uint8 => Market)` with a market count before the first mainnet deploy. |
| Base + native USDC | **Keep** | Cheap gas, fast blocks, Circle-native USDC with EIP-3009. Depeg policy is still unwritten. |
| Every fill = user intent + 2 of 3 approvers, contract re-checks economics | **Keep** | The strongest part of the design. A compromised API or a single approver cannot fill outside on-chain bounds. Residual risk (two compromised approvers) is explicitly bounded by caps. |
| Approvers run the same code on (planned) different providers | **Keep, fix** | Independence today is only on paper: all three share one RPC in qualification, and the planned Cloudflare container would have held all three keys in one secret. Real independence needs separate hosts, keys and RPCs. |
| Off-chain pending-exposure reservations journaled before any signature leaves | **Keep** | Carefully reasoned and well tested. Heavy for a two-market canary, but correct. |
| Global pro-rata resolution instead of auto-deleveraging | **Keep, fix** | Transparent and fair, but today anyone can trigger it permanently once maker backing dips below the *opening* floor, there is no way back except an upgrade, and leftover maker/insurance capital is locked forever. Needs a grace period or lower threshold, an exit path, and a surplus sweep. |
| Upgradeable transparent proxy + ProxyAdmin under a 72h timelock + 2-of-3 Safe; separate tighten-only emergency Safe | **Keep, fix** | Right shape. Spec said 3-of-5 governance; testnet uses 2-of-3. Any emergency pause costs at least 72h downtime because only governance can unpause; accept that explicitly or add a bounded emergency unpause. No mainnet timelock contract or governed-upgrade script exists yet. |
| 21,000-byte self-imposed bytecode gate | **Reverse** | It has pushed the code into minified, single-line Solidity, storage-writing "math" libraries and reused error names. EIP-170 allows 24,576 bytes. Restructure the contract into readable modules instead (see [05](05-refactor-and-rewrite-plan.md)). |
| Pyth as the operational oracle (Chainlink Data Streams adapter kept "supported") | **Keep Pyth, record it** | Pyth is what actually runs and works. The Chainlink adapter is untested against a real verifier and should be treated as non-functional. Formally record Pyth as primary and decide the outage policy. |
| No unsigned or historical oracle fallback | **Keep, fix** | Correct for safety, but an oracle outage blocks withdrawals for anyone with a position until governance swaps the oracle (72h). Needs a documented outage path. |
| Oracle freshness 15s at the contract, 8s at approvers | **Keep** | Measured on testnet; the spec's 2s/8s was never achievable. Update the spec. Also make recorded prices monotonic (today an older price can overwrite a newer one). |
| Funding: skew ÷ net market limit, capped ±100% APR | **Revisit** | Spec scales by $250k skew; contract scales by the market limit (default $5M), so funding is about 20x lower than specified at defaults. Changing the limit also re-prices past funding retroactively. |
| Gas sponsorship from an API hot wallet with daily budgets (no paymaster/4337) | **Keep** | Simplest working approach. The "externally enforced refill reserve" from the design was never built; daily in-process ceilings replaced it silently. Fine for a canary. |
| Optional on-chain scoped session keys | **Keep, fix** | Good UX. Contract lets any account overwrite another user's session key entry (griefing). Session expiry max is 30 days vs a 24h spec. |

## Off-chain architecture

| Decision | Verdict | Why |
| --- | --- | --- |
| One active API leader with an in-process reservation lock | **Keep** | Correct for a single writer. Warm standby and fenced promotion are designed but not implemented; manual failover is acceptable for a canary. |
| SQLite journals per role (no customer database; chain is the ledger) | **Keep** | Locality is a security property for signer/sender journals. Add migrations and continuous off-host backup (Litestream). |
| Custom SQLite indexer instead of Ponder | **Revisit** | Ponder was dropped over a 2026-09 dependency audit. The custom indexer wipes and rebuilds on any reorg and has its own "finalized" definition. Re-evaluate Ponder (or Envio) on Postgres; otherwise fix the custom one. |
| Hyperliquid hedging through a long-lived Python SDK child process | **Reverse (later)** | Adds a second runtime and is hard-pinned to testnet. A TypeScript venue adapter removes Python from production. Not urgent for a canary that may run unhedged at tiny size. |
| Hedger trusts the indexer's exposure | **Reverse** | The design doc says it reads the chain directly. It should: two contract reads. |
| Cloudflare for edge and static sites | **Keep** | Workers Static Assets + an edge Worker is the right tool. |
| Cloudflare Containers for the financial services | **Already reversed, finish the cleanup** | Ephemeral disk loses journals, and all keys sat in one environment variable. Delete the leftover runtime worker, `Dockerfile.cloudflare` and `prepare-cloudflare-runtime.ts`. |
| Persistent Linux hosts with one systemd unit per role | **Keep** | Good hardening (file locks, sandboxing, startup attestation across two RPCs). Providers are still placeholders. |
| Privacy-oriented VPS providers (Bulgaria, Netherlands, Iceland) | **Revisit** | Mentioned once and never again. Pick providers on reliability, key custody and legal fit; record the choice. |
| Raw `window.ethereum` + ethers instead of wagmi/viem | **Reverse** | No EIP-6963 discovery, no WalletConnect/mobile, no smart-wallet support. The release checklist requires a wallet matrix this stack cannot meet. |
| No logging in any service (`logger:false`) | **Reverse** | Incidents would be undiagnosable. |
| Code written as minified one-liners, no formatter | **Reverse** | The single largest obstacle to review, audit and ownership. |

## Process

| Decision | Verdict | Why |
| --- | --- | --- |
| Two milestones: hosted testnet, then a capped mainnet canary | **Keep** | Matches your plan. I add a "mainnet contracts, paused" step in between so mainnet addresses exist early without risking funds. |
| 72h frozen-candidate qualification before release | **Keep, fix** | The two canaries use opposite retry policies, and retries are not recorded, so "0 failures" can hide many rejections. |
| Calibration stays research-only; no automatic parameter activation | **Keep** | Right call. Nothing has been calibrated from real flow yet. |
| Many dated design and audit documents at the repo root | **Reverse** | 36 overlapping docs; several "canonical" ones contradict each other. Consolidate into about eight docs plus an archive (see [05](05-refactor-and-rewrite-plan.md#documentation)). |
