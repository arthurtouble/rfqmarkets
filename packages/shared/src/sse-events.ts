/** Client-side event-stream parsing, shared by services and packages that consume SSE feeds. */

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
