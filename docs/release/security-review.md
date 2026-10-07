# Security review, October 2026

A full pass over the contracts, backend services, Cloudflare edge, CI and frontend apps on `main` as of 7 October 2026. Each finding was traced to a concrete path before it was listed. Fixes that need no contract upgrade ship as pull requests; findings that need a contract upgrade or an operator decision are listed under [Needs a decision](#needs-a-decision) and stay open in the [release checklist](release-checklist.md) until handled.

## Fixed

| Severity | Area | Finding | Fix |
| --- | --- | --- | --- |
| Critical | CI | The Cloudflare deploy workflows ran on any green `CI` run whose head branch was named `main`, including a fork PR opened from the fork's own `main`. The job checked out the fork's commit and ran it with `CLOUDFLARE_API_TOKEN`, the Alchemy key and the RPC URLs, which was enough to redeploy the dev runtime or an oracle worker and read the approver, sponsor and oracle signer keys. | #34: deploys require a `push` to this repository's `main`; checkouts drop persisted credentials; release-image write permissions are scoped to the publish job; the dev runtime container runs as `node`. |

| Medium | Oracle | A node trusted one RPC for the index-to-symbol mapping, and the signed price carries only the index, so a compromised RPC could make nodes sign one market's price for another. Feed freshness tracked the connection, not the ticker. | #40: each index is pinned to its symbol through `ORACLE_MARKETS`, RPC must be https, quotes older than 30s are not live, crossed books clear. |
| Low | Services | Bearer tokens compared with `===`; the approver accepted an empty token; hedger `/health` leaked raw bridge errors; no total hedge position cap; edge asset fallback skipped security headers. | #40. |
| High | Trading app | The app signed whatever EIP-712 payload the API's prepare endpoints returned and took the clearing, token and chain from `/v1/config`. A compromised API or edge could redirect a withdrawal, flip a trade, authorise an attacker session key, or point a deposit approval at another contract. | Branch `claude/project-thread-mss3gf-web-signing`: every payload is checked against what the user asked for before signing, the signed typed data is rebuilt from the trusted domain and bundled types, and deployed builds pin `VITE_CHAIN_ID`, `VITE_CLEARING_ADDRESS` and `VITE_TOKEN_ADDRESS`. |

Further fixes are tracked in the pull requests linked from the project thread; this table is updated as they merge.

## Needs a decision

These need a contract upgrade (a mainnet broadcast) or an operator choice, so they were not changed in code.

### Contracts

- **Medium: the report submitter chooses which signed prices make up a report.** A report is any `threshold` batches from distinct signers within `maxSkew` (5s) of each other, and the clearing contract accepts it if it is newer than the stored price and at most 15s old. With three nodes and threshold two, the median is the average of the two batches the submitter picks, from any second in the last 15. `liquidate`, `refreshOracle` followed by `withdraw`, and `submitResolutionObservation` are permissionless, so a keeper can liquidate at the lowest available pair and a trader can withdraw against the most favourable one. Mitigations, any of: require every configured signer (or one shared timestamp) on permissionless paths; require `observedAt >= block.timestamp - 2` for liquidation and withdrawal; value liquidation at the price most favourable to the account across the supplied batches. (`oracle/SignedPriceOracle.sol`, `libraries/RFQLedger.sol`.)
- **Low: resolution samples have no schedule.** Sample 3 must be at least 30s after sample 1, with no upper bound, and each sample is fixed by whoever submits first. A large claimant can wait for favourable prints. Fix: a fixed window per sample. (`libraries/RFQResolution.sol`.)
- **Low: a third party can start resolution before signatures are checked.** `beginTrade` settles funding for `intent.account` before any signature check; if the funding owed exceeds `makerBacking`, resolution starts and `executeTrade` returns without verifying anything. The same holds for `liquidate` on a non-liquidatable account. This is a real shortfall when it fires, but it skips the incident grace period the design gives the maker to recapitalise. Fix: verify signatures before settling funding, or start an incident clock instead of resolving. (`libraries/RFQSettlement.sol`, `libraries/RFQLiquidation.sol`.)
- **Low: `CloseIntent` has no price bound.** A sponsored close carries no `limitPrice`, so the relayer picks the timing and report (see the first item). Fix: add `limitPrice` and check it against the exit price; the API and app change with it. (`RFQTypes.sol`.)
- **Low: one stale market halts every trade.** Any market with open interest and a stale price makes all trades revert, including reductions elsewhere, and blocks withdrawals and liquidations for accounts holding it. Fix: skip stale markets for reductions or use a conservative last price, and list only liquid markets. (`libraries/RFQRiskMath.sol`.)
- **Low: `withdrawMakerExcess` undercounts what the maker owes.** Customer PnL is netted per market, so an underwater account's uncollectable loss offsets other customers' gains, and unsettled funding is ignored. Governance-only. Fix: count gains only, or add a buffer.
- **Governance: single EOA with no timelock.** On mainnet the governance address also owns the ProxyAdmin and can upgrade immediately. After a timelock is in place, also forbid `setOracle` and upgrades once resolution has started, since users cannot withdraw then.

Checked and sound: EIP-712 domain binding, signature malleability, approver and oracle quorum de-duplication, nonce burning, session key limits, initializer locking, reentrancy guards, `SafeERC20` use, the single `unchecked` block, oracle freshness, margin and liquidation flows, resolution claim batching and loop bounds.

### Services and operations

- **Oracle signing quorum shares an RPC provider.** Covered by the oracle hardening fix (registry allowlist); operators should still run each oracle node against a different RPC provider.
- **Separate sponsor keys.** Nothing enforces that the API and keeper use different sponsor keys. If they share one, their separate nonce journals fork. Keep them separate (`deploy/host/README.md`).
- **The hedger cannot start on Base mainnet.** `persistent-service.ts` passes the mainnet Hyperliquid URL but the hedger and bridge only allow testnet. It fails closed (quotes return 503) and blocks a mainnet launch until the mainnet path is enabled deliberately.
- **Expired vulnerability exception.** The zlib waiver in `security/vulnerability-exceptions.json` expired on 30 September 2026, so the release image gate fails until zlib is upgraded or the waiver is renewed with a fresh rationale.
- **Repository settings.** Put the dev deploy behind a protected GitHub environment and require approval for workflow runs from outside contributors.
- **WalletConnect project.** Restrict the project ID's allowed domains in the Reown dashboard.
