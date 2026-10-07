import assert from "node:assert/strict";
import { test } from "node:test";
import { clientIdentity } from "./client-identity.js";

const request = (peer: string, header?: string | string[]) => ({
  ip: peer,
  socket: { remoteAddress: peer },
  headers: header === undefined ? {} : { "cf-connecting-ip": header },
});

test("without a configured header the peer address is the client", () => {
  const client = clientIdentity();
  assert.equal(client(request("127.0.0.1", "203.0.113.9")), "127.0.0.1");
});

test("the edge header keys clients only from loopback or a trusted proxy", () => {
  const client = clientIdentity({ clientIpHeader: "cf-connecting-ip", trustedProxy: ["10.0.0.2"] });
  assert.equal(client(request("127.0.0.1", "203.0.113.9")), "203.0.113.9");
  assert.equal(client(request("::1", "2001:db8::1")), "2001:db8::1");
  assert.equal(client(request("10.0.0.2", "198.51.100.4")), "198.51.100.4");
  assert.equal(client(request("198.51.100.7", "203.0.113.9")), "198.51.100.7", "direct callers cannot spoof");
});

test("malformed or repeated edge headers fall back to the peer", () => {
  const client = clientIdentity({ clientIpHeader: "cf-connecting-ip" });
  assert.equal(client(request("127.0.0.1")), "127.0.0.1");
  assert.equal(client(request("127.0.0.1", "not-an-ip")), "127.0.0.1");
  assert.equal(client(request("127.0.0.1", "203.0.113.9, 198.51.100.1")), "127.0.0.1");
  assert.equal(client(request("127.0.0.1", ["203.0.113.9", "198.51.100.1"])), "127.0.0.1");
});
