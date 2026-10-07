import assert from "node:assert/strict";
import { test } from "node:test";
import {
  bearerMatches,
  constantTimeEqual,
  isLoopbackHost,
  isSecureOrLoopbackUrl,
  requireSecureOrLoopbackUrl,
} from "./auth.js";

test("constant-time comparison matches only identical secrets", () => {
  assert.equal(constantTimeEqual("secret", "secret"), true);
  assert.equal(constantTimeEqual("secret", "secreT"), false);
  assert.equal(constantTimeEqual("secret", "secret-longer"), false);
  assert.equal(constantTimeEqual("", ""), true);
});

test("bearer headers match exactly and an empty token never matches", () => {
  const token = "a".repeat(32);
  assert.equal(bearerMatches(`Bearer ${token}`, token), true);
  assert.equal(bearerMatches([`Bearer ${token}`], token), true);
  assert.equal(bearerMatches(`bearer ${token}`, token), false);
  assert.equal(bearerMatches(token, token), false);
  assert.equal(bearerMatches(undefined, token), false);
  assert.equal(bearerMatches("Bearer ", ""), false);
});

test("service URLs must be https unless they point at loopback", () => {
  for (const url of [
    "https://rpc.example",
    "wss://feed.example",
    "http://127.0.0.1:8545",
    "http://localhost:4100",
    "http://[::1]:4100",
    "http://api.localhost",
  ])
    assert.equal(isSecureOrLoopbackUrl(url), true, url);
  for (const url of ["http://rpc.example", "http://10.0.0.1", "ftp://127.0.0.1", "not a url", ""])
    assert.equal(isSecureOrLoopbackUrl(url), false, url);
  assert.equal(isLoopbackHost("127.1.2.3"), true);
  assert.equal(isLoopbackHost("127.example.com"), false);
  assert.throws(
    () => requireSecureOrLoopbackUrl("RPC_URL", "http://rpc.example/key-123"),
    (error: Error) =>
      /RPC_URL must be an https URL/.test(error.message) && !error.message.includes("key-123"),
  );
});
