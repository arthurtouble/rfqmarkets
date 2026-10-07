import { Container } from "@cloudflare/containers";
import { admitAtEdge } from "./edge-admission.mjs";
import { OracleHistory, handleHistoryRequest, syncHistory } from "./oracle-history.mjs";
import { ensureOracleSigner, oracleDomainFor, publicOracleSigner } from "./oracle-identity.mjs";
import {
  oracleNodeMarketEnv,
  oracleRequestRoute,
  oracleSyncMarkets,
  oracleWorkerMarkets,
  oracleWorkerSettings,
} from "./oracle-worker-routes.mjs";

// One oracle node (services/oracle-node) per worker: oracle-1/-2/-3, deployed one at a time
// from wrangler.oracle.jsonc. The Durable Object owns the node's signer key (oracle-identity.mjs), starts
// the container only for the adapter recorded in KV `deployment.json` when this node is one of its
// signers, and keeps price history in its SQLite storage (oracle-history.mjs).
// Markets: the ORACLE_MARKETS var (wrangler.oracle.jsonc). With an ORACLE_RPC_URL secret the node also
// checks the clearing registry and prices only the listed markets whose on-chain index and symbol match
// (oracleNodeMarketEnv; docs/operations/adding-a-market.md).
const PORT = 4900,
  CHAIN_ID = "8453";
const json = (value, status = 200, headers = {}) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers },
  });
const CORS = { "access-control-allow-origin": "*", "access-control-allow-methods": "GET, HEAD, OPTIONS" };
const withCors = (response) => {
  const copy = new Response(response.body, response);
  for (const [name, value] of Object.entries(CORS)) copy.headers.set(name, value);
  return copy;
};

export class RFQOracleNode extends Container {
  defaultPort = PORT;
  requiredPorts = [PORT];
  sleepAfter = "720h";
  enableInternet = true;
  checkedUntil = 0;
  readinessState = null;
  checking = null;
  historyStore = null;

  get history() {
    this.historyStore ??= new OracleHistory(this.ctx.storage.sql);
    return this.historyStore;
  }

  /** The node's key, created on first use; only the address is published (KV `oracle-node-<n>.json`). */
  async signer() {
    const signer = await ensureOracleSigner(this.ctx.storage),
      key = `oracle-node-${oracleWorkerSettings(this.env).index}.json`,
      published = JSON.stringify(publicOracleSigner(signer));
    if ((await this.env.DEV_STATE.get(key)) !== published) await this.env.DEV_STATE.put(key, published);
    return signer;
  }

  readiness() {
    if (Date.now() < this.checkedUntil) return Promise.resolve(this.readinessState);
    this.checking ??= this.check().finally(() => {
      this.checking = null;
    });
    return this.checking;
  }

  remember(state, ms) {
    this.readinessState = state;
    this.checkedUntil = Date.now() + ms;
    return state;
  }

  async check() {
    const signer = await this.signer(),
      text = await this.env.DEV_STATE.get("deployment.json");
    let deployment = null;
    try {
      deployment = text ? JSON.parse(text) : null;
    } catch {
      return this.remember({ ready: false, reason: "deployment_unreadable", signer: signer.address }, 30_000);
    }
    const domain = oracleDomainFor(deployment, signer.address);
    if (!domain.ready) {
      // Never keep signing for a domain the current deployment does not authorize.
      await this.stopSigning();
      return this.remember({ ...domain, signer: signer.address }, 30_000);
    }
    try {
      await this.startSigning(signer, domain.verifyingContract, deployment);
    } catch {
      return this.remember({ ready: false, reason: "node_start_failed", signer: signer.address }, 10_000);
    }
    return this.remember(
      { ready: true, signer: signer.address, chainId: CHAIN_ID, verifyingContract: domain.verifyingContract },
      15_000,
    );
  }

  async startSigning(signer, verifyingContract, deployment) {
    const envVars = {
      ORACLE_SIGNER_KEY: signer.privateKey,
      ORACLE_CHAIN_ID: CHAIN_ID,
      ORACLE_VERIFYING_CONTRACT: verifyingContract,
      ORACLE_HOST: "0.0.0.0",
      ORACLE_PORT: String(PORT),
      ...oracleNodeMarketEnv(this.env, deployment),
    };
    // Any implicit restart by the Container class must use the same domain.
    this.envVars = envVars;
    await this.startAndWaitForPorts({ ports: PORT, startOptions: { envVars } });
    const health = await this.nodeHealth();
    if (
      health &&
      (health.signer !== signer.address ||
        health.chainId !== CHAIN_ID ||
        String(health.verifyingContract).toLowerCase() !== verifyingContract.toLowerCase())
    ) {
      // A fresh deployment (new adapter): restart the node for the new domain.
      await this.destroy();
      await this.startAndWaitForPorts({ ports: PORT, startOptions: { envVars } });
    }
  }

  async stopSigning() {
    this.envVars = {};
    const state = await this.getState();
    if (state.status === "running" || state.status === "healthy") await this.destroy();
  }

  async nodeHealth() {
    try {
      return await (await this.containerFetch(`http://container/health`, PORT)).json();
    } catch {
      return null;
    }
  }

  async nodeJson(path) {
    const response = await this.containerFetch(`http://container${path}`, PORT);
    if (!response.ok) throw new Error(`node returned ${response.status}`);
    return await response.json();
  }

  /** Cron: keeps the node running for the current deployment and copies its history into SQLite. */
  async tick() {
    const ready = await this.readiness();
    if (!ready.ready) return ready;
    this.history.signer = ready.signer.toLowerCase();
    try {
      return {
        ...ready,
        sync: await syncHistory(this.history, (path) => this.nodeJson(path), {
          markets: oracleSyncMarkets(await this.nodeHealth(), oracleWorkerMarkets(this.env)),
        }),
      };
    } catch (error) {
      return { ...ready, sync: { error: error.message } };
    }
  }

  async fetch(request) {
    const route = oracleRequestRoute(request),
      url = new URL(request.url);
    if (route === "history")
      return handleHistoryRequest(this.history, url) ?? json({ error: "route_not_found" }, 404);
    if (route !== "node") return json({ error: "route_not_found" }, 404);
    const ready = await this.readiness();
    if (!ready.ready)
      return json({ ok: false, error: "oracle_not_ready", reason: ready.reason, signer: ready.signer }, 503, {
        "retry-after": "30",
      });
    try {
      return await this.containerFetch(
        new Request(`http://container${url.pathname}${url.search}`, {
          method: request.method,
          headers: request.headers,
          signal: request.signal,
        }),
        PORT,
      );
    } catch {
      this.checkedUntil = 0;
      return json({ ok: false, error: "oracle_starting" }, 503, { "retry-after": "5" });
    }
  }
}

/** The worker's single node, pinned near its region (getContainer takes no location hint). */
function oracleNode(env) {
  const { instance, locationHint } = oracleWorkerSettings(env);
  return env.ORACLE_NODE.get(env.ORACLE_NODE.idFromName(instance), { locationHint });
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    const route = oracleRequestRoute(request);
    if (route === null) return withCors(json({ error: "route_not_found" }, 404));
    if (route === "method")
      return withCors(json({ error: "method_not_allowed" }, 405, { allow: "GET, HEAD" }));
    const rejected = await admitAtEdge(request, env);
    if (rejected) return withCors(rejected);
    return withCors(await oracleNode(env).fetch(request));
  },
  async scheduled(_event, env, context) {
    context.waitUntil(oracleNode(env).tick());
  },
};
