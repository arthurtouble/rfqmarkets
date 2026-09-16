# Candidate gross approval reservations

This describes repository implementation and local evidence. It does not qualify production limits, Byzantine coordination, keys, journals or RPC finality agreements.

## Envelope and publication

An API reservation precedes every approval request that can return a signature. It reserves the full positive base delta as additional customer long capacity, or the full negative delta as additional short capacity. Existing positions and opposing pending requests do not reduce this amount. For every execution subset and account ordering, additional long base is bounded by the sum of positive deltas, and additional short base by the sum of negative delta magnitudes. This intentionally over-reserves ordinary closes and offsetting requests on the same account.

A signed reduceOnly=true intent contributes zero additional gross capacity because clearing rejects any transition that fails to strictly reduce absolute account size without crossing zero. Multiple competing reduce-only requests cannot create new exposure: an incompatible later request reverts. Use signed reduceOnly for close intents; a request merely described as a close has no such guarantee. Net/stress risk from removing an offset still undergoes the existing canonical checks and independent point-in-time model.

Admission adds the reservation envelope to the chain-derived gross book and values both directional and total base at authenticated asks. Missing migration state, unavailable prices or exceeded side/gross capacity reject additional gross signing. Reductions do not refund capacity held by another pending approval. The API refreshes other markets with outstanding gross risk, even when their chain net and gross position are zero.

API reservations deduplicate by quote ID and bind base delta, market and reduceOnly. Approvers deduplicate by signed intent hash: several price/report/expiry approvals for one intent consume one directional reservation with the maximum issued deadline, since a single owner nonce cannot fill twice. A retry cannot change these bound inputs or shorten retained expiry.

## Journals, expiry and recovery

One exclusive process per journal/signing identity is required. Restore/import requires service fencing and the same pinned signing context; cloned keys with independent journals do not meet this assumption. The host writer-lock packaging still requires an actual failover rehearsal.

The API atomically stores its full approval artifact, commitment and gross reservation before requesting signatures. Each approver stores its signature/full payload and gross reservation in one SQLite transaction before returning the signature. Memory publication follows durable commit. Lost replies, minority signatures, failed simulations and included receipts retain gross capacity.

Expiry is governed by the maximum issued maker-approval deadline. Capacity is released only when independently observed finalized chain time is strictly past that deadline. Wall-clock expiry, an included/reverted receipt or a newer unfinalized block does not release it. Unknown, unsupported, future or divergent finality proofs retain capacity. Approvers with a secondary provider require its finalized height to cover the primary checkpoint and its corresponding header hash/timestamp to agree.

Accepted finalized block number, timestamp and hash are persisted atomically with expiry deletions. Restart restores this checkpoint and rejects older admission snapshots. A different timestamp/hash at the same finalized height or a regressing checkpoint is rejected. Reservation journals also bind their configured chain/proxy context and, for an approver, its signing identity; they cannot silently follow another deployment/key. Independent signers verify primary/secondary chain IDs before reading admission state.

The shared indexed expiry heap stores at most one entry per active ID. Rescheduling/cancelling does not retain obsolete heap entries. Totals are read in constant time; expiry drains at most 512 records per call, conservatively leaving any backlog reserved. New reservations are capped at 50,000 per signer and the API's configured active-quote capacity.

One-time API legacy backfill conservatively uses the original owner-intent expiry when exact escaped approval coverage is uncertain. Complete approver payloads reconstruct exact intent/directional risk and maximum approval expiry. Null legacy payloads cannot reconstruct risk: signer readiness/signing remain closed until the persisted finalized checkpoint proves all such records expired. Restore/import of missing full artifacts remains an operator qualification task.

Authenticated signer recovery exports cover the finalized boundary, including full signatures/payloads, incomplete records, gross reservations and the accepted checkpoint. Private API metrics expose reservation counts/checkpoint. Public endpoints do not export private approval recovery records.

## Coordination boundary

With correctly journaled signers, any two 2-of-3 quorums intersect at a signer holding the earlier reservation. A second API process with an empty journal cannot acquire a conflicting gross quorum by hiding the first API's commitments. A reservation is retained even when that signer participated in a minority or lost response.

This is not Byzantine reservation consensus. Two quorums can intersect only at a compromised signer that ignores its book; the two honest signers can then each approve a different request against the same capacity. Canonical clearing caps reject the excess transaction, and the local adversarial fixture verifies unchanged customer/maker accounting. Preventing the conflicting certificates themselves requires reviewed peer reservation publication/certificates or a different coordination/quorum design. That work is unfinished.

Outstanding work also includes conservative pending net/stress/realized-capital envelopes, full policy/venue differential qualification, calibration, independent module/protocol reviews, journal restore/fencing rehearsals, provisioned finality/oracle agreements. Gross reservations do not guarantee every outstanding certificate will fill under later market prices, capital movements, liquidation, nonce cancellation or policy changes.

## Local evidence

The deterministic envelope test checks 65,536 execution subset/order histories, including contract-enforced reduce-only transitions. Fault fixtures lose quorum responses, restart API and signers, orphan an included fill, use a second API with fresh state, verify honest quorum intersection, preserve incomplete legacy signer exclusion, retain capacity under advancing unfinalized time, and release only after a finalized proof. A compromised shared signer can create conflicting certificates, but the canonical gross cap rejects the excess trade atomically.

Unit tests cover immutable retries, transaction rollback, deadline equality, persisted checkpoint/context recovery, finality regressions/hash conflicts, missing/divergent proofs, bounded expiry batches, 50,000 reschedules of one ID and indexed-heap reference interleavings. Production evidence remains the independent audit and sustained qualification process in the implementation plan.

Admission now performs optimistic remote reads, then checks the pending inventory revision inside a synchronous durable reservation section. An intervening inventory change causes bounded repricing/retry. Signer calls and settlement simulation occur after publication and outside the lock. Duplicate active submissions share one completed operation; retry pricing excludes its own existing pending ID without releasing gross capacity.
