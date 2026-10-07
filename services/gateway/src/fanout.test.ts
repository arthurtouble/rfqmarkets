import assert from "node:assert/strict";
import { test } from "node:test";
import { MarketFanout, consumeMarketEvents, type FanoutClient } from "./fanout.js";

class Client implements FanoutClient {
  writes = 0;
  bytes = 0;
  closed = false;
  write(chunk: string) {
    this.writes++;
    this.bytes += chunk.length;
    return true;
  }
  bufferedBytes() {
    return this.bytes;
  }
  close() {
    this.closed = true;
  }
}

test("100,000 idle stream clients share complete frames with bounded gateway work", () => {
  const hub = new MarketFanout(Number.MAX_SAFE_INTEGER),
    clients = Array.from({ length: 100_000 }, () => new Client());
  for (const client of clients) hub.add(client);
  const started = performance.now();
  hub.publish('{"sequence":1}');
  const elapsed = performance.now() - started;
  assert.equal(hub.status().connections, 100_000);
  assert.equal(hub.status().eventsSent, 100_000);
  assert(clients.every((client) => client.writes === 1));
  assert(elapsed < 1_000, `one 100k fanout took ${elapsed.toFixed(1)}ms`);
  const reconnect = new Client();
  hub.add(reconnect);
  assert.equal(reconnect.writes, 1, "reconnect did not receive the latest complete frame");
  hub.close();
});

test("slow readers are disconnected before their buffers become unbounded", () => {
  const hub = new MarketFanout(100),
    fast = new Client(),
    slow = new Client();
  slow.bytes = 101;
  hub.add(fast);
  hub.add(slow);
  hub.publish("{}");
  assert.equal(slow.closed, true);
  assert.equal(fast.writes, 1);
  assert.equal(hub.status().droppedSlowClients, 1);
});

test("heartbeats and snapshot replay enforce the same slow-reader bound", () => {
  const hub = new MarketFanout(10),
    slowHeartbeat = new Client();
  slowHeartbeat.bytes = 11;
  hub.add(slowHeartbeat);
  hub.heartbeat();
  assert.equal(slowHeartbeat.closed, true);
  hub.publish("{}");
  const slowReconnect = new Client();
  slowReconnect.bytes = 11;
  hub.add(slowReconnect);
  assert.equal(slowReconnect.closed, true);
  assert.equal(hub.status().connections, 0);
});

test("upstream parser forwards market events and ignores heartbeats", async () => {
  const chunks = [
      'event: markets\ndata: {"a":1}',
      '\n\n: heartbeat\n\nevent: other\ndata: no\n\nevent: markets\ndata: {"a":2}\n\n',
    ],
    stream = new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
        controller.close();
      },
    }),
    values: string[] = [];
  await consumeMarketEvents(new Response(stream, { status: 200 }), (value) => values.push(value));
  assert.deepEqual(values, ['{"a":1}', '{"a":2}']);
});
