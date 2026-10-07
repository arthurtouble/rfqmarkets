import type { ServerResponse } from "node:http";
import type { FastifyInstance } from "fastify";
import { clientIdentity } from "../../../packages/shared/src/client-identity.js";
import { ConnectionBudget } from "../../../packages/shared/src/connection-budget.js";
import { DEFAULT_CORS_ORIGIN, type ApiOptions } from "./context.js";
import { publicError } from "./public-error.js";
import type { QuoteEngine } from "./quoting.js";

type StreamClient = { response: ServerResponse; writable: boolean };

/** A slow client whose unsent backlog passes this many bytes is disconnected. */
const MAX_CLIENT_BACKLOG_BYTES = 262_144;
const PUBLISH_COALESCE_MS = 40;
const HEARTBEAT_MS = 15_000;

/** Server-sent market snapshots, coalesced and deduplicated across all connected clients. */
export class MarketStream {
  private readonly clients = new Set<StreamClient>();
  private readonly connections: ConnectionBudget;
  private readonly client: ReturnType<typeof clientIdentity>;
  private sequence = 0;
  private publishing = false;
  private publishQueued = false;
  private lastPayload = "";
  private publishTimer: ReturnType<typeof setTimeout> | undefined;
  private heartbeatTimer: ReturnType<typeof setInterval> | undefined;

  constructor(
    private readonly options: ApiOptions,
    private readonly quoting: QuoteEngine,
  ) {
    this.client = clientIdentity(options);
    this.connections = new ConnectionBudget(
      options.maxStreamConnections ?? 1000,
      options.maxStreamConnectionsPerClient ?? 8,
    );
  }

  get stats() {
    return { connections: this.clients.size, eventsSent: this.sequence };
  }

  private write(client: StreamClient, event: string, payload: unknown) {
    const { response } = client;
    if (response.destroyed || response.writableEnded) return;
    if (!client.writable) {
      if (response.writableLength > MAX_CLIENT_BACKLOG_BYTES) response.destroy();
      return;
    }
    const ok = response.write(
      `id: ${++this.sequence}\nevent: ${event}\ndata: ${JSON.stringify(payload)}\n\n`,
    );
    if (!ok) {
      client.writable = false;
      response.once("drain", () => {
        client.writable = true;
      });
    }
  }

  private writeError(client: StreamClient, error: unknown) {
    this.write(client, "stream-error", { error: publicError(error, "market data unavailable") });
  }

  schedulePublish(delay = PUBLISH_COALESCE_MS) {
    if (!this.clients.size) return;
    if (this.publishing) {
      this.publishQueued = true;
      return;
    }
    if (this.publishTimer) return;
    this.publishTimer = setTimeout(() => {
      this.publishTimer = undefined;
      void this.publish();
    }, delay);
    this.publishTimer.unref();
  }

  private async publish() {
    if (this.publishing) return;
    this.publishing = true;
    try {
      if (this.clients.size) {
        try {
          const snapshot = await this.quoting.readMarkets(),
            payload = JSON.stringify(snapshot);
          if (payload !== this.lastPayload) {
            this.lastPayload = payload;
            for (const client of this.clients) this.write(client, "markets", snapshot);
          }
        } catch (error) {
          for (const client of this.clients) this.writeError(client, error);
        }
      }
    } finally {
      this.publishing = false;
      if (this.publishQueued) {
        this.publishQueued = false;
        this.schedulePublish();
      }
    }
  }

  register(app: FastifyInstance) {
    app.get("/v1/markets/stream", async (request, reply) => {
      const release = this.connections.acquire(this.client(request));
      if (!release)
        return reply.code(429).header("retry-after", "5").send({ error: "stream connection limit reached" });
      reply.raw.once("close", release);
      reply.hijack();
      reply.raw.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        "access-control-allow-origin": this.options.corsOrigin ?? DEFAULT_CORS_ORIGIN,
      });
      const client: StreamClient = { response: reply.raw, writable: true };
      this.clients.add(client);
      reply.raw.on("close", () => this.clients.delete(client));
      void this.quoting
        .readMarkets()
        .then((snapshot) => this.write(client, "markets", snapshot))
        .catch((error) => this.writeError(client, error));
    });
  }

  start() {
    this.heartbeatTimer = setInterval(() => {
      for (const client of this.clients) client.response.write(": heartbeat\n\n");
    }, HEARTBEAT_MS);
    this.heartbeatTimer.unref();
  }

  close() {
    if (this.publishTimer) clearTimeout(this.publishTimer);
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    for (const client of this.clients) client.response.end();
  }
}
