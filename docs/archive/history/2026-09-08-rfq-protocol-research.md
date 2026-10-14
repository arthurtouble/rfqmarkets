# RFQ authorization research and revised candidate

2026-09-08. Primary documentation and selected public source inspection. This is an architecture comparison, not a deployed-bytecode audit or a verification of private market-maker infrastructure. Repository main branches and versioned protocol documentation must not be assumed to match every current deployment.

## Distinct keys, not distinct machines

Each approver has its own independently generated private key and a different registered signer address. Copying key A onto another server produces another instance of signer A, not signer B. Two signatures by A count as one identity, even if their byte encodings differ.

On-chain verification must reject duplicate recovered addresses and unauthorized addresses. It must require the configured number of distinct signers over exactly the same digest under the current signer-set version. Never count signatures by array length alone. Configuration must reject duplicate and zero-address signers. Use a vetted signature recovery library, not hand-written ECDSA.

As a reference for the uniqueness pattern, [Safe's public contract](https://github.com/safe-fndn/safe-smart-account/blob/main/contracts/Safe.sol) verifies owner membership and strictly increasing signer addresses. This is a reference for distinct-signature handling, not a recommendation to copy Safe's full transaction executor into settlement.

Threshold/MPC signatures are different: separate shares jointly produce a signature under one public key. Replicating a complete private key is not threshold signing. MPC prevents some key-extraction scenarios but does not automatically make signer policy independent or quotes correct.

## What other protocols expose publicly

| Protocol | Documented mechanism | Relevance and limit |
| --- | --- | --- |
| Hashflow | Off-chain RFQ with a configured maker/pool signer. | Close match for quote authentication; spot settlement does not solve perpetual margin and insolvency. |
| 0x RFQ | Maker or registered signer authorizes an order; contracts check order validity and fill constraints. | Another direct maker-authorization model, not a requirement for a quote validator committee. |
| SYMMIO | Bilateral derivatives with collateralized counterparties and Muon attestations for price/uPnL-related operations. | Closest reviewed derivatives analogue. Oracle/computation attestations are distinct from counterparty willingness to trade. |
| CoW Protocol | Signed user orders, solver-submitted settlements and contract-enforced execution constraints. | Useful intent/settlement separation; batch-auction model rather than the same sole-maker RFQ product. |
| Hyperliquid | Validator consensus orders transactions; HyperCore contains matching and margin state. | Full exchange/chain consensus, not a small committee approving a Base application's maker prices. |

Hashflow's [maker integration documentation](https://docs.hashflow.com/hashflow/market-making/getting-started-api-v3) describes binding the quote to pool, trader, amounts, nonce, expiry and chain. Its linked [pool source](https://github.com/hashflownetwork/x-protocol/blob/main/evm/contracts/pools/HashflowPool.sol) checks recovered signatures against the configured signer and includes signer-management controls. Those interfaces do not reveal whether an individual market maker internally uses one machine, an HSM or multiple approving services.

0x documents [RFQ orders and registered signers](https://docs.0xprotocol.org/en/latest/basics/orders.html) and [fill/cancellation checks](https://docs.0xprotocol.org/en/latest/basics/functions.html). A valid quote is maker consent; the signature is not an independent certification of fair market value. Do not mechanically copy protocol-specific transaction-origin restrictions into our user authorization model.

SYMMIO's [overview](https://docs.symm.io/) describes trading against collateralized solvers. Its [frontend documentation](https://docs.symm.io/frontend-builder-documentation/frontend-builder-sdk) explains Muon price/uPnL verification, and the [Muon SDK documentation](https://doc.trading-sdk.symm.io/core/muon/) describes quorum-signed attestations for relevant account and position operations. Exact live quorum membership, thresholds, gateway dependencies and deployment configuration were not verified here. Its [public core repository](https://github.com/SYMM-IO/protocol-core) also documents Diamond upgrades; that is a precedent for mutable derivatives logic, not evidence that we need its module count or should adopt its trust assumptions wholesale.

CoW's [settlement documentation](https://docs.cow.fi/cow-protocol/reference/contracts/core/settlement) specifies signature, expiry, fill and user-price checks, with allowlisted solvers and bonds because settlement interactions introduce additional risk. It demonstrates that solver competition and settlement validation have different jobs.

Hyperliquid's [HyperCore overview](https://hyperliquid.gitbook.io/hyperliquid-docs/hypercore/overview) and [consensus description](https://hyperliquid.gitbook.io/hyperliquid-docs/hypercore/staking) describe validator agreement on transaction ordering. Building that system would materially expand our scope.

## Three verification jobs

1. Authorization: user consents to a limited intent; the maker's registered authority consents to exact execution terms.
2. External observations: an oracle attests to specified market data under its own security assumptions. Authenticity alone does not guarantee freshness or economic representativeness.
3. State transition: contracts calculate margin, liabilities, nonce consumption, budgets and allowable withdrawals using current on-chain state.

Keep accounting that can be computed economically on-chain in the contracts. Asking a committee to attest to arbitrary balances introduces a stronger trust dependency than asking it to authorize a trade. A proof-based off-chain computation system is another option, but proof circuits, data availability and proving operations are a substantial additional project; proofs do not establish external-price truth.

An extra network of our own validators is unnecessary if Base orders transactions and executes these checks. Our approval services are maker security infrastructure. If we control all of them, they should not be described as independent protocol governance or public decentralization.

## Revised production candidate: two of three independent approvals

Given the stated objection to one approver outage halting RFQ execution, prototype two-of-three ordinary signatures as the production candidate. Keep the quoter unsigned. Request approval from all three concurrently and settle with the first two valid approvals over identical terms. Services must each enforce the entire required approval policy; a special safety check present on only one service can be bypassed by the other pair.

Expected failure behavior, assuming correct contracts and two honest services:

- One service unavailable or withholding: the other two can approve valid trades.
- One key stolen: the attacker cannot authorize a trade rejected by both honest services.
- Two keys stolen: maker authorization is compromised; contract limits still apply.
- Shared bad data, shared exploitable code or common deployment compromise: the nominal node count may offer little protection.
- Shared oracle, chain, ingress or coordinator outage: two-of-three signing does not solve it.

This is a trade authorization quorum, not a Byzantine consensus protocol. Two different pairs could authorize conflicting orders or orders competing for the same capital. The contract must serialize fills, consume user nonces and enforce shared exposure/budget limits atomically. Do not promise irreversible off-chain fills from two signatures or hedge every approval as if settlement were final. Durable reservations and hedge reconciliation remain necessary.

The three services hold different secrets, on independently administered infrastructure where practical. No quoter, relayer, online provisioning token or frontend deployment credential may mint new signer authority. Separate cold governance changes signer membership; revocation/pause cannot silently reduce the threshold. Quotes have short deadlines and bind signer-set/protocol versions; replacing a signer invalidates obsolete approvals. Independent emergency exits and liquidations need their own explicit rules.

A hardware-backed signer is optional defense in depth. Hashflow publishes an [AWS KMS signer library](https://github.com/hashflownetwork/aws-kms-ethers-signer), demonstrating the integration pattern, not proving its use by all makers. Managed signing introduces provider and account dependencies relevant to our privacy objective. HSMs do not prevent misuse of valid signing API credentials.

## Verification specification and tests before capital

Use [EIP-712](https://eips.ethereum.org/EIPS/eip-712) for our typed approval and user-intent domains. The standard explicitly leaves replay protection to the application. Bind chain ID, contract, protocol/signer-set version, user intent hash, exact amount/price/fee, quote ID and expiry. Enforce cancellation, session scope, replay protection and fixed-point arithmetic in settlement.

Tests must reject duplicate signer identities, different digests, old sets, replayed nonces, changed fees/recipients, invalid recovery and malformed signatures. Exercise one unavailable signer, a malicious signer, concurrent oversubscription, signer replacement, chain rollback and price-feed disagreement. Benchmark quote-to-inclusion latency and approval rejection rates under these failures.

Recommendation is conditional on those tests and the operational ability to keep three trust domains meaningfully separate. This is a better availability match than two-of-two, not a claim that more signatures guarantee profitable quotes or that this exact scheme is the industry default.
