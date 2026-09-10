# Production release checklist

Status date: 2026-09-10. This is the promotion record for a capped Base mainnet canary. Every box needs retained evidence and a named reviewer. Passing the local and testnet gates does not authorize real capital by itself.

## Candidate freeze

- [ ] Tag one reviewed commit and record the source, lockfile, Solidity compiler, build-info and frontend hashes.
- [ ] Run `npm test`; require every contract, upgrade, simulator, service, type and frontend gate to pass from a clean checkout.
- [ ] Run the production dependency audit; require `npm audit --omit=dev` to report zero findings. Review development-only findings separately.
- [ ] Verify implementation bytecode remains below the 21,000-byte project gate and repeat OpenZeppelin storage validation.
- [ ] Verify the deployed implementation, linked libraries, proxy, ProxyAdmin, oracle adapter, USDC, Safe and timelock addresses from two independent RPCs and the explorer.

## Economic and protocol gates

- [ ] Freeze per-market trade and aggregate caps, margin tiers, minimum maker capital, insurance target, spread/fee floor, price tolerance, hedge band and liquidation parameters from replay and stress evidence.
- [ ] Require zero worse-than-signed-limit fills and zero duplicate nonce execution across all test suites and the sustained testnet run.
- [ ] Run at least one upgrade and rollback rehearsal with funded accounts and open BTC/ETH positions; confirm custody, nonces, sessions, positions and claims retain exact storage values.
- [ ] Exercise funding catch-up, partial and full liquidation, deficit waterfall, resolution sampling, pro-rata claims and post-resolution recovery.
- [ ] Obtain independent Solidity and economic reviews and close every critical/high issue before promotion.

## External integration gates

- [ ] Run `soak:base-sepolia-iteration` for the agreed window with authenticated Pyth, independent Base RPCs and Hyperliquid testnet. Preserve per-cycle transaction/order IDs and p50/p95/p99/error measurements.
- [ ] Test oracle disconnect, stale/short-lived proof replacement, malformed proof, market mismatch, fee change and provider disagreement. New risk must fail closed; an authorized conservative exit must remain available.
- [ ] Test RPC throttling, divergent heads, delayed receipts, nonce replacement, sponsor depletion and API death after durable signing and after broadcast.
- [ ] Fence the Hyperliquid agent to the dedicated account, cap available venue capital, rotate it, restore it on a clean host and prove a standby cannot become a second writer.
- [ ] Validate injected desktop, WalletConnect/mobile and ERC-1271 wallets. Validate quick-session limits, revocation, expiration and browser-secret loss.
- [ ] Select and audit the LI.FI or Socket route adapter. Test allowance scope, destination USDC identity, minimum output, timeout, refund, source reorg and destination failure before enabling cross-chain deposits.

## Infrastructure and operations gates

- [ ] Place each approver in a separate provider/failure domain with an independently generated hardware-backed key and independently authorized release. No operator can retrieve two keys.
- [ ] Expose approvers only through authenticated private transport. Deny public ingress and verify the denial externally.
- [ ] Deploy one active API writer and warm standbys with distinct gas wallets. Rehearse epoch promotion, commitment reconciliation and DNS/edge routing without double submission.
- [ ] Put the public static UI and stateless SSE gateway behind edge DDoS controls. Keep the direct contract exit interface independently hosted and reproducibly built.
- [ ] Verify `/v1/config`, health, errors, logs and browser bundles contain no oracle, RPC, signer, hedge or transport credential; configure a separate browser-safe `RFQ_PUBLIC_RPC_URL`.
- [ ] Put the hedge dashboard and internal documentation behind identity-aware private access. Keep trading credentials out of both browser and dashboard processes.
- [ ] Alert on oracle age, proof-budget refreshes/failures, approval disagreement, quorum loss, signed-to-inclusion latency, sender ambiguity, gas runway, indexer lag/reorg, hedge gap, venue rejection and capital headroom.
- [ ] Restore API, approver, sender, indexer and hedge journals from encrypted backups on clean hosts. Record recovery time and reconcile every chain/venue operation.
- [ ] Assign incident owners and run pause, approver compromise, oracle failure, RPC partition, venue outage, frontend compromise and resolution drills.

## Capped launch and expansion

- [ ] Begin with one or two markets, conservative per-trade/aggregate caps, excess maker/insurance capital and a documented maximum daily loss.
- [ ] Require measured normal-mode operational rejection below 0.5%, p95 approval-to-inclusion within the chosen budget, zero stale-proof reverts after automatic refresh, and bounded hedge gap/cost.
- [ ] Hold limits unchanged through the observation window. Raise one dimension at a time only after reviewing fills, markouts, hedge cost, oracle/RPC errors, capital stress and incidents.
- [ ] Publish verified addresses, contract source, risk parameters, upgrade delay, emergency powers, oracle dependencies and an accurate statement of operator trust.
