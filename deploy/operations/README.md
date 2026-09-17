# Operational evidence

Keep the collector configuration and outputs on the monitoring host with mode `0600`. The collector needs read-only RPC access, the operations bearer token, public service health endpoints, and the seven current snapshot manifests. It never writes credentials into its output.

```sh
RFQ_OPERATIONS_TOKEN=... npm run collect:operations-snapshot -- deploy/operations/snapshot.json operational-snapshot.json
npm run check:operations-alerts -- operational-snapshot.json operational-alerts.json
```

The snapshot command fails unless the backup set contains API, all three approvers, indexer, hedger, and keeper from one environment, chain, clearing deployment, and candidate. `operations-alerts` exits with status 2 when a paging threshold is crossed. Send that status and JSON output to monitoring outside the runtime provider; do not expose the operations token to the public edge.

Run `npm run evidence:backup-set -- backup-set.json MANIFEST_JSON...` after every coordinated recovery-point capture and retain the output with the encrypted snapshots. The evidence digest binds every role manifest without copying journal contents into the monitoring artifact.
