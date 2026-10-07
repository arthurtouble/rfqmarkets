import { createHash, timingSafeEqual } from "node:crypto";

/**
 * Security helpers shared by the services and their launch scripts: constant-time bearer token checks
 * and the https-or-loopback rule for service-to-service URLs.
 */

const digest = (value: string) => createHash("sha256").update(value, "utf8").digest();

/**
 * Compares two secrets in constant time. Both sides are hashed first, so neither the content nor the
 * length of the expected value leaks through timing.
 */
export function constantTimeEqual(actual: string, expected: string) {
  return timingSafeEqual(digest(actual), digest(expected));
}

/** True when an `authorization` header carries exactly `Bearer <token>`. An empty token never matches. */
export function bearerMatches(header: string | string[] | undefined, token: string) {
  if (!token) return false;
  const value = Array.isArray(header) ? header[0] : header;
  return constantTimeEqual(value ?? "", `Bearer ${token}`);
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

/** True for `localhost`, `*.localhost`, 127.0.0.0/8 and ::1. */
export function isLoopbackHost(hostname: string) {
  const host = hostname.toLowerCase();
  return LOOPBACK_HOSTS.has(host) || host.endsWith(".localhost") || /^127(?:\.\d{1,3}){3}$/.test(host);
}

/** True when `url` is https/wss, or http/ws to a loopback host (local development). */
export function isSecureOrLoopbackUrl(url: string) {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol === "https:" || parsed.protocol === "wss:") return true;
  return (parsed.protocol === "http:" || parsed.protocol === "ws:") && isLoopbackHost(parsed.hostname);
}

/** Throws unless `url` is https (or loopback); `name` is the setting, never the URL (it may hold a key). */
export function requireSecureOrLoopbackUrl(name: string, url: string) {
  if (!isSecureOrLoopbackUrl(url)) throw new Error(`${name} must be an https URL (http only for loopback)`);
  return url;
}
