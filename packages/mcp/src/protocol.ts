// A minimal Model Context Protocol server over stdio: newline-delimited JSON-RPC 2.0 with the
// initialize handshake, ping, tools/list and tools/call. It has no dependencies so agents can run it
// with nothing but this repository and Node.

import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";

/** Protocol revisions this server speaks, newest first. */
export const PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"] as const;

export type JsonSchema = Record<string, unknown>;

export interface Tool {
  name: string;
  title?: string;
  description: string;
  inputSchema: JsonSchema;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; openWorldHint?: boolean };
  /** Returns what the agent reads back; an Error thrown here becomes an `isError` result, not a protocol error. */
  run(args: Record<string, unknown>): Promise<unknown>;
}

export interface ServerInfo {
  name: string;
  version: string;
  instructions?: string;
}

type Request = {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
};

const error = (id: Request["id"], code: number, message: string) => ({
  jsonrpc: "2.0" as const,
  id: id ?? null,
  error: { code, message },
});
const result = (id: Request["id"], value: unknown) => ({
  jsonrpc: "2.0" as const,
  id: id ?? null,
  result: value,
});

/** Tool output as one text block: strings as they are, anything else as indented JSON. */
const text = (value: unknown) => (typeof value === "string" ? value : JSON.stringify(value, null, 2));

/**
 * Handles one JSON-RPC message and returns the response, or undefined for a notification. Exposed for
 * tests; `serve` wires it to stdio.
 */
export async function handle(info: ServerInfo, tools: readonly Tool[], message: unknown) {
  if (!message || typeof message !== "object" || (message as Request).jsonrpc !== "2.0")
    return error(null, -32600, "invalid request");
  const request = message as Request;
  const notification = request.id === undefined;
  if (typeof request.method !== "string")
    return notification ? undefined : error(request.id, -32600, "invalid request");
  switch (request.method) {
    case "initialize": {
      const asked = String(request.params?.protocolVersion ?? "");
      const version = (PROTOCOL_VERSIONS as readonly string[]).includes(asked) ? asked : PROTOCOL_VERSIONS[0];
      return result(request.id, {
        protocolVersion: version,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: info.name, version: info.version },
        ...(info.instructions ? { instructions: info.instructions } : {}),
      });
    }
    case "ping":
      return notification ? undefined : result(request.id, {});
    case "tools/list":
      return result(request.id, {
        tools: tools.map(({ name, title, description, inputSchema, annotations }) => ({
          name,
          ...(title ? { title } : {}),
          description,
          inputSchema,
          ...(annotations ? { annotations } : {}),
        })),
      });
    case "tools/call": {
      const name = request.params?.name,
        tool = tools.find((candidate) => candidate.name === name);
      if (!tool) return error(request.id, -32602, `unknown tool: ${String(name)}`);
      const args = request.params?.arguments;
      try {
        const value = await tool.run(
          args && typeof args === "object" ? (args as Record<string, unknown>) : {},
        );
        return result(request.id, { content: [{ type: "text", text: text(value) }] });
      } catch (failure) {
        const reason = failure instanceof Error ? failure.message : String(failure);
        return result(request.id, { content: [{ type: "text", text: reason }], isError: true });
      }
    }
    default:
      // Notifications such as notifications/initialized need no answer.
      return notification ? undefined : error(request.id, -32601, `method not found: ${request.method}`);
  }
}

/** Serves the tools over newline-delimited JSON-RPC until `input` ends. */
export function serve(info: ServerInfo, tools: readonly Tool[], input: Readable, output: Writable) {
  const lines = createInterface({ input, crlfDelay: Infinity });
  const write = (value: unknown) => output.write(`${JSON.stringify(value)}\n`);
  let queue = Promise.resolve();
  lines.on("line", (line) => {
    if (!line.trim()) return;
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      write(error(null, -32700, "parse error"));
      return;
    }
    // Answer in arrival order; a slow trade does not let a later read overtake it.
    queue = queue.then(async () => {
      const response = await handle(info, tools, message);
      if (response) write(response);
    });
  });
  return new Promise<void>((resolve) => lines.on("close", () => void queue.then(resolve)));
}
