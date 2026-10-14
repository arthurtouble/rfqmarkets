import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { PROTOCOL_VERSIONS, handle, serve, type Tool } from "./protocol.js";

const info = { name: "test", version: "1.0.0", instructions: "be nice" };
const tools: Tool[] = [
  {
    name: "echo",
    description: "Echoes its input",
    inputSchema: { type: "object" },
    annotations: { readOnlyHint: true },
    run: async (args) => args,
  },
  {
    name: "fail",
    description: "Always fails",
    inputSchema: { type: "object" },
    run: async () => {
      throw new Error("no luck");
    },
  },
];
const call = (message: unknown) => handle(info, tools, message);

test("initialize agrees on a protocol version and describes the server", async () => {
  const response = await call({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-03-26" },
  });
  assert.deepEqual(response, {
    jsonrpc: "2.0",
    id: 1,
    result: {
      protocolVersion: "2025-03-26",
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: "test", version: "1.0.0" },
      instructions: "be nice",
    },
  });
  const unknown = await call({
    jsonrpc: "2.0",
    id: 2,
    method: "initialize",
    params: { protocolVersion: "1999" },
  });
  assert.equal(
    (unknown as { result: { protocolVersion: string } }).result.protocolVersion,
    PROTOCOL_VERSIONS[0],
  );
});

test("tools are listed without their handlers", async () => {
  const response = (await call({ jsonrpc: "2.0", id: 1, method: "tools/list" })) as {
    result: { tools: Array<Record<string, unknown>> };
  };
  assert.deepEqual(response.result.tools[0], {
    name: "echo",
    description: "Echoes its input",
    inputSchema: { type: "object" },
    annotations: { readOnlyHint: true },
  });
  assert.equal(response.result.tools.length, 2);
  assert.ok(!("run" in response.result.tools[0]));
});

test("tool results come back as text and failures as tool errors", async () => {
  assert.deepEqual(
    await call({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "echo", arguments: { a: 1 } },
    }),
    { jsonrpc: "2.0", id: 3, result: { content: [{ type: "text", text: '{\n  "a": 1\n}' }] } },
  );
  assert.deepEqual(await call({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "fail" } }), {
    jsonrpc: "2.0",
    id: 4,
    result: { content: [{ type: "text", text: "no luck" }], isError: true },
  });
  const missing = (await call({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "nope" } })) as {
    error: { code: number };
  };
  assert.equal(missing.error.code, -32602);
});

test("notifications get no answer and unknown requests get method not found", async () => {
  assert.equal(await call({ jsonrpc: "2.0", method: "notifications/initialized" }), undefined);
  assert.deepEqual(await call({ jsonrpc: "2.0", id: 9, method: "ping" }), {
    jsonrpc: "2.0",
    id: 9,
    result: {},
  });
  assert.equal(((await call({ jsonrpc: "2.0", id: 6, method: "resources/list" })) as any).error.code, -32601);
  assert.equal(((await call({ id: 7, method: "ping" })) as any).error.code, -32600);
});

test("serve answers each line in order over stdio", async () => {
  const input = new PassThrough(),
    output = new PassThrough();
  let written = "";
  output.on("data", (chunk) => (written += chunk));
  const done = serve(info, tools, input, output);
  input.write('{"jsonrpc":"2.0","id":1,"method":"ping"}\n');
  input.write("not json\n");
  input.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n\n');
  input.end('{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"echo","arguments":{}}}\n');
  await done;
  const lines = written
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  // The parse error is written at once; the queued requests follow in order.
  assert.deepEqual(
    lines.map((line) => [line.id, line.error?.code]),
    [
      [null, -32700],
      [1, undefined],
      [2, undefined],
    ],
  );
});
