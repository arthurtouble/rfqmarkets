import { isIP } from "node:net";

/** Edge headers a service may key per-client budgets on. Only set by a trusted edge. */
export type ClientIpHeader = "cf-connecting-ip";

export interface ClientIdentityOptions {
  /** Header carrying the end-user address, honored only from a trusted proxy hop. */
  clientIpHeader?: ClientIpHeader;
  /** Exact peer addresses allowed to set `clientIpHeader`, in addition to loopback. */
  trustedProxy?: string | string[];
}

type IdentifiableRequest = {
  ip: string;
  headers: Record<string, string | string[] | undefined>;
  socket?: { remoteAddress?: string };
};

const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

/**
 * Per-client budget key. Without a configured header this is the peer address Fastify resolved.
 * With one, the header's single IP literal is used only when the TCP peer is loopback or an
 * explicitly trusted proxy; any other peer, or a malformed or repeated header, falls back to the
 * peer address so a direct caller cannot invent identities.
 */
export function clientIdentity(options: ClientIdentityOptions = {}) {
  const header = options.clientIpHeader;
  if (!header) return (request: IdentifiableRequest) => request.ip;
  const trusted = new Set([
    ...LOOPBACK,
    ...(Array.isArray(options.trustedProxy)
      ? options.trustedProxy
      : options.trustedProxy
        ? [options.trustedProxy]
        : []),
  ]);
  return (request: IdentifiableRequest) => {
    const peer = request.socket?.remoteAddress;
    if (!peer || !trusted.has(peer)) return request.ip;
    const value = request.headers[header];
    if (typeof value !== "string") return request.ip;
    const address = value.trim();
    return isIP(address) ? address : request.ip;
  };
}
