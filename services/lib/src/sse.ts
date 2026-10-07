import type { ServerResponse } from "node:http";
import type { FastifyReply } from "fastify";

/** Server-sent events plumbing shared by the gateway, indexer, hedger and oracle sources. */

export function sseFrame(event: string, data: unknown, id?: number) {
  const body = typeof data === "string" ? data : JSON.stringify(data);
  return `${id === undefined ? "" : `id: ${id}\n`}event: ${event}\ndata: ${body}\n\n`;
}

export const SSE_HEARTBEAT = ": heartbeat\n\n";

/** The allowed origin to echo for a request: its own origin when listed, otherwise the first one. */
export function allowedOrigin(allowed: string | readonly string[], requestOrigin: string | undefined) {
  const origins = typeof allowed === "string" ? [allowed] : allowed;
  return requestOrigin && origins.includes(requestOrigin) ? requestOrigin : origins[0];
}

/**
 * Takes the response over from Fastify and writes event-stream headers. Fastify's CORS plugin does
 * not run for hijacked replies, so the caller passes the allowed origin(s).
 */
export function openSse(reply: FastifyReply, corsOrigin?: string | readonly string[]): ServerResponse {
  const origin = corsOrigin && allowedOrigin(corsOrigin, reply.request.headers.origin);
  reply.hijack();
  reply.raw.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
    ...(origin ? { "access-control-allow-origin": origin, vary: "origin" } : {}),
  });
  return reply.raw;
}

/**
 * A set of open event streams. Clients whose unsent buffer exceeds the limit are disconnected
 * rather than allowed to grow server memory.
 */
export class SseClients {
  private clients = new Set<ServerResponse>();
  private dropped = 0;
  constructor(private maxBufferedBytes = 256 * 1024) {}
  get size() {
    return this.clients.size;
  }
  get droppedSlowClients() {
    return this.dropped;
  }
  /** Registers a stream and returns a remover; the stream is also removed when it closes. */
  add(response: ServerResponse) {
    this.clients.add(response);
    const remove = () => this.clients.delete(response);
    response.once("close", remove);
    return remove;
  }
  send(response: ServerResponse, frame: string) {
    if (response.destroyed || response.writableEnded) {
      this.clients.delete(response);
      return false;
    }
    if (response.writableLength > this.maxBufferedBytes) {
      this.clients.delete(response);
      this.dropped++;
      response.destroy();
      return false;
    }
    response.write(frame);
    return true;
  }
  broadcast(frame: string) {
    let sent = 0;
    for (const response of this.clients) if (this.send(response, frame)) sent++;
    return sent;
  }
  heartbeat() {
    this.broadcast(SSE_HEARTBEAT);
  }
  close() {
    for (const response of this.clients) response.end();
    this.clients.clear();
  }
}

export { readSseEvents, type SseEvent } from "../../../packages/shared/src/sse-events.js";
