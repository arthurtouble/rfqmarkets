import { recoverAddress, type Contract } from "ethers";
import { firstQuorum } from "./quorum.js";

export type ApproverSignature = { digest: string; signer: string; signature: string };
export type ApproverEndpoint = { url: string; token: string };

// Each approver makes about twenty single-request RPC reads per approval. One second was too tight
// for the first trade after boot and for remote providers; every deployed profile already used 5 s.
const DEFAULT_APPROVER_TIMEOUT_MS = 5_000;
const MAX_CACHED_QUORUMS = 100_000;
export const APPROVAL_QUORUM = 2;

/** Requests approver co-signatures and returns the first distinct quorum for a digest. */
export class ApprovalCollector {
  private readonly quorums = new Map<string, Promise<PromiseSettledResult<ApproverSignature>[]>>();

  constructor(
    private readonly approvers: ApproverEndpoint[],
    private readonly fetchImpl: typeof fetch,
    private readonly clearing?: Contract,
    private readonly timeoutMs = DEFAULT_APPROVER_TIMEOUT_MS,
  ) {}

  /** Number of configured approvers. */
  get size() {
    return this.approvers.length;
  }

  private async request(approver: ApproverEndpoint, digest: string, payload: unknown) {
    const response = await this.fetchImpl(`${approver.url}/approve`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${approver.token}` },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok) throw new Error(`approver ${response.status}: ${await response.text()}`);
    const result = (await response.json()) as ApproverSignature;
    if (
      result.digest !== digest ||
      recoverAddress(digest, result.signature).toLowerCase() !== result.signer.toLowerCase()
    )
      throw new Error("invalid approver response");
    if (this.clearing && !(await this.clearing.isApprover(result.signer)))
      throw new Error("signer is not a current approver");
    return result;
  }

  collect(digest: string, payload: unknown) {
    const existing = this.quorums.get(digest);
    if (existing) return existing;
    const job = firstQuorum(
      this.approvers.map((approver) => this.request(approver, digest, payload)),
      (result) => result.signer.toLowerCase(),
      APPROVAL_QUORUM,
    ).then((results) => {
      if (distinctSigners(results).size < APPROVAL_QUORUM) this.quorums.delete(digest);
      return results;
    });
    // Successful immutable approvals are safe to reuse for idempotent client
    // retries. Bound the cache independently of active quote capacity.
    if (this.quorums.size >= MAX_CACHED_QUORUMS) this.quorums.delete(this.quorums.keys().next().value!);
    this.quorums.set(digest, job);
    return job;
  }
}

/** Fulfilled approver signatures keyed by lower-case signer, in first-response order. */
export function distinctSigners(results: PromiseSettledResult<ApproverSignature>[]) {
  const signers = new Map<string, ApproverSignature>();
  for (const item of results)
    if (item.status === "fulfilled") signers.set(item.value.signer.toLowerCase(), item.value);
  return signers;
}
