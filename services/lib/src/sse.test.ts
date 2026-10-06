import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { ServerResponse } from "node:http";
import { test } from "node:test";
import { SseClients, readSseEvents, sseFrame } from "./sse.js";

const body = (...chunks: string[]) =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
      controller.close();
    },
  });

test("parses events split across chunks, CRLF endings, comments and multi-line data", async () => {
  const events = [];
  for await (const event of readSseEvents(
    body(
      ": heartbeat\n\nid: 7\r\nevent: mar",
      'kets\r\ndata: {"a":1}\r\n\r',
      "\n",
      "data: one\ndata: two\n\n",
    ),
  ))
    events.push(event);
  assert.deepEqual(events, [
    { event: "markets", data: '{"a":1}', id: "7" },
    { event: "message", data: "one\ntwo" },
  ]);
});

test("formats frames with optional ids", () => {
  assert.equal(sseFrame("status", { ok: true }), 'event: status\ndata: {"ok":true}\n\n');
  assert.equal(sseFrame("markets", "raw", 3), "id: 3\nevent: markets\ndata: raw\n\n");
});

class FakeResponse extends EventEmitter {
  writes: string[] = [];
  writableLength = 0;
  destroyed = false;
  writableEnded = false;
  write(chunk: string) {
    this.writes.push(chunk);
    return true;
  }
  end() {
    this.writableEnded = true;
    this.emit("close");
  }
  destroy() {
    this.destroyed = true;
    this.emit("close");
  }
}

test("broadcasts, evicts slow clients and forgets closed ones", () => {
  const clients = new SseClients(10),
    fast = new FakeResponse(),
    slow = new FakeResponse(),
    gone = new FakeResponse();
  for (const response of [fast, slow, gone]) clients.add(response as unknown as ServerResponse);
  gone.emit("close");
  slow.writableLength = 11;
  assert.equal(clients.broadcast("frame"), 1);
  assert.deepEqual(fast.writes, ["frame"]);
  assert.equal(slow.destroyed, true);
  assert.equal(clients.size, 1);
  assert.equal(clients.droppedSlowClients, 1);
  clients.close();
  assert.equal(fast.writableEnded, true);
  assert.equal(clients.size, 0);
});
