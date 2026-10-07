// Ensures a Cloudflare Access application guards HOSTNAME and prints `--var` flags for `wrangler deploy`
// (ACCESS_TEAM_DOMAIN and ACCESS_AUD), which deploy/cloudflare/static/private-edge.mjs checks on every request.
// Usage: node scripts/cloudflare-access.mjs HOSTNAME NAME
// A new application signs people in with their Cloudflare account and admits only members of this
// Cloudflare account (the "cloudflare" login method, restricted to account members); an existing one keeps
// the policy it has. When Access is not enabled on the account or the API token lacks the Access permissions
// (Access: Apps and Policies Edit; Access: Organizations, Identity Providers, and Groups Read), this prints
// nothing and warns, and the worker deploys locked: it refuses every request until a later deploy succeeds here.
const [hostname, name] = process.argv.slice(2);
if (!hostname || !name) throw new Error("usage: cloudflare-access.mjs HOSTNAME NAME");
const { CLOUDFLARE_API_TOKEN: token, CLOUDFLARE_ACCOUNT_ID: account } = process.env;
const base = `https://api.cloudflare.com/client/v4/accounts/${account}/access`;

async function call(path, init = {}) {
  const response = await fetch(`${base}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.success === false)
    throw new Error(
      `${init.method ?? "GET"} access${path}: ${body.errors?.map((e) => e.message).join("; ") || response.status}`,
    );
  return body.result;
}

try {
  const organization = await call("/organizations");
  const teamDomain = organization.auth_domain;
  if (!teamDomain) throw new Error("the Access organization has no team domain");
  const apps = await call("/apps?per_page=100");
  let app = apps.find((item) => item.domain === hostname);
  if (!app) {
    const login = (await call("/identity_providers")).find((item) => item.type === "cloudflare");
    if (!login?.config?.restrict_to_account_members)
      throw new Error("no Cloudflare-account login method restricted to account members");
    app = await call("/apps", {
      method: "POST",
      body: JSON.stringify({
        name,
        domain: hostname,
        type: "self_hosted",
        session_duration: "24h",
        app_launcher_visible: false,
        allowed_idps: [login.id],
        auto_redirect_to_identity: true,
        policies: [
          {
            name: `${name} account members`,
            decision: "allow",
            include: [{ login_method: { id: login.id } }],
          },
        ],
      }),
    });
    console.error(`created Access application ${name} for ${hostname}`);
  }
  if (!app.aud) throw new Error(`Access application for ${hostname} has no audience tag`);
  console.log(`--var ACCESS_TEAM_DOMAIN:${teamDomain} --var ACCESS_AUD:${app.aud}`);
} catch (error) {
  console.error(
    `::warning::Cloudflare Access is not set up for ${hostname} (${error.message}); deploying it locked`,
  );
}
