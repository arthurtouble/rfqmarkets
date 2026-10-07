// Cloudflare Access check for the private dev surfaces (hedge operations dashboard, internal docs).
// Access sits in front of the worker; this verifies the Cf-Access-Jwt-Assertion header as well, so a request
// that reaches the worker without passing Access (the policy is missing, or ACCESS_AUD is unset) is refused.
// ACCESS_TEAM_DOMAIN is the team's cloudflareaccess.com host and ACCESS_AUD the application's audience tag,
// both set by scripts/cloudflare-access.mjs at deploy time.
const CERTS_TTL_MS = 5 * 60_000;
let certs = { domain: null, keys: null, fetchedAt: 0 };

const decode = (part) => Uint8Array.from(atob(part.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
const parse = (part) => JSON.parse(new TextDecoder().decode(decode(part)));

async function signingKeys(domain, fetcher) {
  if (certs.domain === domain && certs.keys && Date.now() - certs.fetchedAt < CERTS_TTL_MS) return certs.keys;
  const response = await fetcher(`https://${domain}/cdn-cgi/access/certs`);
  if (!response.ok) throw new Error(`access certs ${response.status}`);
  const { keys } = await response.json();
  certs = { domain, keys, fetchedAt: Date.now() };
  return keys;
}

/** Returns the verified token claims, or null when the request did not pass this application's Access policy. */
export async function verifyAccess(request, env, { fetcher = fetch, now = Date.now() } = {}) {
  const domain = env.ACCESS_TEAM_DOMAIN, audience = env.ACCESS_AUD;
  if (!domain || !audience) return null;
  const token = request.headers.get("cf-access-jwt-assertion");
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const header = parse(parts[0]), claims = parse(parts[1]);
    if (header.alg !== "RS256") return null;
    const jwk = (await signingKeys(domain, fetcher)).find((key) => key.kid === header.kid);
    if (!jwk) return null;
    const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
    const signed = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
    if (!(await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, decode(parts[2]), signed))) return null;
    const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!audiences.includes(audience) || claims.iss !== `https://${domain}`) return null;
    const seconds = now / 1000;
    if (typeof claims.exp !== "number" || claims.exp < seconds || (claims.nbf ?? 0) > seconds + 60) return null;
    return claims;
  } catch {
    return null;
  }
}

export function accessDenied(env) {
  const configured = Boolean(env.ACCESS_TEAM_DOMAIN && env.ACCESS_AUD);
  return new Response(
    configured
      ? "Sign in through Cloudflare Access to open this page."
      : "This private page is locked until Cloudflare Access is configured for it.",
    {
      status: configured ? 403 : 503,
      headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" },
    },
  );
}

export function resetAccessCacheForTests() {
  certs = { domain: null, keys: null, fetchedAt: 0 };
}
