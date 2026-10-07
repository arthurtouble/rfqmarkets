/** Never expose provider URLs, transport credentials or signed request bodies. */
export function publicError(error: unknown, fallback: string): string {
  const safeMessages = new Set([
    "market is paused",
    "exposure migration required",
    "firm quote capacity reached",
    "order capacity reached",
    "oracle report lacks inclusion time",
    "hedging unavailable: only exposure-reducing trades are allowed",
  ]);
  if (error instanceof Error && safeMessages.has(error.message)) return error.message;
  const names: Record<string, string> = {
    Margin: "Insufficient margin",
    Stale: "Oracle or authorization expired",
    Replay: "Nonce already used",
    InvalidTrade: "Trade violates settlement policy",
    InvalidSignature: "Invalid signature",
    Unauthorized: "Unauthorized action",
    Insolvent: "Settlement requires resolution",
    OracleInvalid: "Oracle proof rejected",
    TriggerNotReached: "Trigger price not reached",
  };
  const value = error as { revert?: { name?: string }; data?: unknown } | null;
  if (value?.revert?.name && Object.hasOwn(names, value.revert.name)) return names[value.revert.name];
  const selectors: Record<string, string> = {
    "0x50cb02e4": "Margin",
    "0xd7815800": "Stale",
    "0xb5a78004": "Replay",
    "0xd69b5379": "InvalidTrade",
    "0x8baa579f": "InvalidSignature",
    "0x82b42900": "Unauthorized",
    "0xdccfcae2": "TriggerNotReached",
  };
  if (typeof value?.data === "string") {
    const name = selectors[value.data.slice(0, 10).toLowerCase()];
    if (name) return names[name];
  }
  return fallback;
}

/**
 * Approver policy reasons that describe the trade itself, so the trader can act on them.
 * Infrastructure failures (RPC, oracle, recovery) stay behind "approver quorum unavailable".
 */
const PUBLIC_POLICY_REASONS = new Set([
  "market disabled",
  "market trade limit exceeded",
  "reduce-only intent does not reduce position",
  "hedge risk requires exposure reduction",
  "guarded hedge limit exceeded",
]);

/**
 * The policy reason that blocked an approval quorum, when enough approvers rejected the trade
 * for the same public reason that quorum could not be reached without them. Undefined otherwise.
 */
export function approverPolicyRejection(
  results: PromiseSettledResult<unknown>[],
  approverCount: number,
  quorum: number,
): string | undefined {
  const counts = new Map<string, number>();
  for (const item of results) {
    if (item.status !== "rejected") continue;
    const match = /^approver 409: (.*)$/s.exec(
      item.reason instanceof Error ? item.reason.message : String(item.reason),
    );
    if (!match) continue;
    let reason: unknown;
    try {
      reason = (JSON.parse(match[1]) as { error?: unknown }).error;
    } catch {
      continue;
    }
    if (typeof reason === "string" && PUBLIC_POLICY_REASONS.has(reason))
      counts.set(reason, (counts.get(reason) ?? 0) + 1);
  }
  for (const [reason, count] of counts) if (count > approverCount - quorum) return reason;
  return undefined;
}
