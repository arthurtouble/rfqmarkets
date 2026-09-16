# Production incident runbook

Every page starts with the same safety action: stop new risk by pausing the clearing contract or disabling both markets through the emergency authority, while leaving the independent exit application and keeper available. Record the block, deployment hash, candidate hash, alert snapshot and operator identity before making a second change.

| Alert | Immediate action | Recovery gate |
| --- | --- | --- |
| `api_unhealthy`, `sender_unresolved` | Remove the API writer from edge routing. Fence its writer lock and reconcile every signed/submitted nonce before promoting a standby. | One writer, zero ambiguous operations, matching journal checkpoint and chain nonce. |
| `approver_quorum_loss`, `approval_disagreement` | Disable new quotes. Do not copy keys or journals between approvers. Compare signed payload digests and finalized checkpoints independently. | Two healthy independent approvers agree on chain, policy, epoch and reservation state. |
| `oracle_stale` | Disable affected markets and keep owner exits/keeper proof refresh available. | Two independent RPC views and the authenticated oracle agree; fresh proof drill succeeds. |
| `indexer_lag` | Remove account views from service and keep contract-direct exits available. Do not advance the finalized cursor manually. | Rebuilt projection matches chain at the retained finalized hash. |
| `keeper_stale` | Start the fenced standby keeper with its own sponsor after reconciling the old sponsor journal. | Fresh BTC/ETH proofs, bounded cycle and no unresolved sponsor nonce. |
| `hedge_gap` | Switch quoting to reduce-only and cancel venue orders only after reconciliation. | Venue position, open orders and finalized customer exposure reconcile inside the configured band. |
| `maker_headroom` | Disable new risk and fund through the reviewed governance path. Never lower the floor during an incident. | Backing exceeds floor and four-corner stress plus reserved maker debits by the launch buffer. |
| `gas_runway` | Refill only the affected bounded sponsor wallet from the treasury procedure. | At least 24 hours measured runway without changing sender ceilings. |
| `backup_stale` | Keep the current writer running but block promotion and deployment. Produce and restore-verify a new encrypted snapshot. | Clean-host integrity check, matching context, measured RTO and reconciled operations. |

Resolution entry, implementation upgrade, signer rotation and mainnet deployment require the governance ceremony and retained review evidence. Never resolve an alert by deleting a journal, resetting a nonce, lowering a risk limit or replacing an authority outside that ceremony.
