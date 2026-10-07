/**
 * Whether the running stack must be restarted for `deployment` (the KV record): it crashed, it runs a
 * different clearing proxy, or it trusts a different oracle signer set (after `dev-contracts.sh
 * oracle-signers`). The oracle source reads its signers once at start, so a stale set means no prices.
 */
export function needsRestart(status, deployment) {
  if (status.phase === "waiting") return false;
  if (status.phase === "exited") return true;
  if (status.clearing?.toLowerCase() !== deployment.contracts.clearingProxy.toLowerCase()) return true;
  return oracleKey(status.oracle) !== oracleKey(deployment.oracle);
}

const oracleKey = (oracle) =>
  oracle
    ? JSON.stringify({
        signers: (oracle.signers ?? []).map((item) => String(item).toLowerCase()),
        threshold: oracle.threshold,
      })
    : "";
