import type { ServerResponse } from "node:http";
import type { FastifyReply } from "fastify";

/** Server-sent events plumbing shared by the gateway, indexer, hedger and oracle sources. */

export function sseFrame(event: string, data: unknown, id?: number) {
  const body = typeof data === "string" ? data : JSON.stringify(data);
  return `${id === undefined ? "" : `id: ${id}\n`}event: ${event}\ndata: ${body}\n\n`;
}

export const SSE_HEARTBEAT = ": heartbeat\n\n";

/**
 * Takes the response over from Fastify and writes event-stream headers. Fastify's CORS plugin does
 * not run for hijacked replies, so the caller passes the origin to allow.
 */
export function openSse(reply: FastifyReply, corsOrigin?: string): ServerResponse {
  reply.hijack();
  reply.raw.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
    ...(corsOrigin ? { "access-control-allow-origin": corsOrigin, vary: "origin" } : {}),
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

export interface SseEvent {
  event: string;
  data: string;
  id?: string;
}

/** Parses an event-stream body. Comments and events without data are skipped. */
export async function* readSseEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<SseEvent> {
  const reader = body.getReader(),
    decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      // Normalise on the whole buffer so a CRLF split across two chunks is still recognised.
      buffer = (buffer + decoder.decode(value, { stream: true })).replaceAll("\r\n", "\n");
      let boundary;
      while ((boundary = buffer.indexOf("\n\n")) >= 0) {
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const parsed: SseEvent = { event: "message", data: "" },
          data: string[] = [];
        for (const line of block.split("\n")) {
          if (line.startsWith("event:")) parsed.event = line.slice(6).trim();
          else if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
          else if (line.startsWith("id:")) parsed.id = line.slice(3).trim();
        }
        if (!data.length) continue;
        parsed.data = data.join("\n");
        yield parsed;
      }
    }
  } finally {
    // Also runs when the consumer stops early: cancel so the upstream connection is released.
    await reader.cancel().catch(() => {});
  }
}
