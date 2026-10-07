import { SSE_HEARTBEAT, readSseEvents, sseFrame } from "../../lib/src/sse.js";

export interface FanoutClient {
  write(chunk: string): boolean;
  bufferedBytes(): number;
  close(): void;
}

export class MarketFanout {
  private clients = new Set<FanoutClient>();
  private latest?: string;
  private sequence = 0;
  private sent = 0;
  private dropped = 0;
  constructor(private maxBufferedBytes = 256 * 1024) {}
  private write(client: FanoutClient, frame: string) {
    if (client.bufferedBytes() > this.maxBufferedBytes) {
      this.clients.delete(client);
      this.dropped++;
      client.close();
      return false;
    }
    client.write(frame);
    return true;
  }
  add(client: FanoutClient) {
    this.clients.add(client);
    if (this.latest) this.write(client, this.latest);
    return () => this.clients.delete(client);
  }
  publish(data: string) {
    const frame = sseFrame("markets", data, ++this.sequence);
    this.latest = frame;
    for (const client of this.clients) if (this.write(client, frame)) this.sent++;
  }
  heartbeat() {
    for (const client of this.clients) this.write(client, SSE_HEARTBEAT);
  }
  close() {
    for (const client of this.clients) client.close();
    this.clients.clear();
  }
  status() {
    return {
      connections: this.clients.size,
      sequence: this.sequence,
      eventsSent: this.sent,
      droppedSlowClients: this.dropped,
      hasSnapshot: Boolean(this.latest),
    };
  }
}

export async function consumeMarketEvents(response: Response, onData: (data: string) => void) {
  if (!response.ok || !response.body) throw new Error(`upstream market stream returned ${response.status}`);
  for await (const event of readSseEvents(response.body)) if (event.event === "markets") onData(event.data);
}
