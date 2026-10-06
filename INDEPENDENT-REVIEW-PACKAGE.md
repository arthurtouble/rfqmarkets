# Independent review package

Candidate identity is produced by `scripts/candidate-identity.ts`; reviewers must record that hash in their report and in release evidence version 2. Review the frozen commit only. Generated local state, test keys and temporary logs are not candidate evidence.

## Contract and economic review

Review `RFQClearing` and its linked modules (`RFQSettlement`, `RFQLiquidation`, `RFQResolution`, `RFQRiskMath`, `RFQSignatureVerifier`, inlined `RFQLedger`), both oracle adapters and proxy initialization/upgrade scripts. Treat linked libraries as implementation authority. Focus on custody conservation, signed-domain and epoch fencing, fee/PnL/funding rounding, cross-margin bankruptcy, maker exhaustion, exposure migration, gross/side/net/stress limits, permissionless incident entry, resolution sampling and claims, owner exits during pause, the maker-incident grace period, the governance handover to `RFQTimelock`, and ERC-7201 storage layout for future upgrades.

Required commands: `npm run test:contracts`, `npm run validate:upgrades`, `npm run test:python`, and the complete `npm test`. The clearing bytecode must remain at or below 21,000 bytes. The OpenZeppelin linked-library allowance is an explicit manual-review item.

## Service and operations review

Review durable sender nonce handling, API/approver recovery artifacts, finalized-only reservation expiry, conservative pending gross/net/stress/maker-debit envelopes, journal context binding, single-writer fencing, independent keeper behavior, hedge reconciliation, edge and origin admission, secret child environments, runtime identity checks, backup/restore and public error redaction.

Exercise response loss before and after broadcast, status-zero receipts, reorg disappearance/reinclusion, API and keeper restart, API outage during liquidation/resolution, signer loss, divergent RPCs, stale/short oracle proofs, venue rejection/partial fill, corrupt backup, standby promotion and alert pages. Never repair a test by deleting journals or resetting nonces.

## Accepted capped-launch residuals

The contract accepts two of three approvers. Two conflicting certificates can intersect only at a compromised signer; honest peer journals are not a Byzantine consensus system. Canonical on-chain exposure and capital checks reject the unsafe excess transaction without customer or maker ledger changes. For the capped launch this is accepted as an availability risk, with conservative limits, independent signers, alerts and a direct exit path. A future quorum redesign requires a separate protocol review.

Cloudflare rate-limit counters are an approximate outer layer. Origin token buckets, connection budgets and contract-wide financial limits remain authoritative. Historical funding uses the documented cached-mark model. Both items require economic/operations sign-off rather than silent assumptions.

## Evidence expected from reviewers

Each report must name one scope (`contracts`, `services`, or `operations`), reviewer identity, candidate hash, review dates, exact tools/versions, findings and dispositions. Critical/high findings must be closed against a new candidate and all reports re-bound to that candidate. Reports, the signed image/SBOM evidence, a successful unchanged 72-hour soak, topology validation and every R1–R16 work artifact are inputs to `npm run release:check`.
