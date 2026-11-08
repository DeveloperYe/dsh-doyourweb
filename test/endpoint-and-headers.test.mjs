import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { BrowserBridge } from "../src/bridge.js";

/** A response stub that records the status and headers instead of writing a socket. */
async function request(bridge, { pathname, host = "127.0.0.1", remoteAddress = "127.0.0.1", secure = false }) {
  // No port in the Host header: the test bridge was never started, so it has no listen port.
  const response = {
    status: undefined, headers: undefined, body: undefined,
    writeHead(code, headers) { this.status = code; this.headers = headers; return this; },
    end(body) { this.body = body; return this; },
  };
  await bridge.handleHttp({ method: "GET", url: pathname,
    headers: { host }, socket: { remoteAddress, encrypted: secure } }, response);
  return response;
}

test("the reported endpoint matches what a browser must actually dial", () => {
  // Local default: the loopback listener.
  const local = new BrowserBridge({ home: path.join(os.tmpdir(), "dsh-endpoint"), port: 43187 });
  assert.equal(local.endpointDescription(), "ws://127.0.0.1:43187/extension");

  // A public URL is authoritative: scheme and port both come from it.
  const published = new BrowserBridge({ home: path.join(os.tmpdir(), "dsh-endpoint"), port: 43187, tls: true,
    publicUrl: "https://203.0.113.10:9443" });
  assert.equal(published.endpointDescription(), "wss://203.0.113.10:9443/extension");

  // Plain HTTP behind a terminator stays ws.
  const plain = new BrowserBridge({ home: path.join(os.tmpdir(), "dsh-endpoint"), port: 43187,
    publicUrl: "http://192.168.1.5:43187" });
  assert.equal(plain.endpointDescription(), "ws://192.168.1.5:43187/extension");

  // TLS without a public URL still has to say wss, on the port the extension dials.
  const tlsOnly = new BrowserBridge({ home: path.join(os.tmpdir(), "dsh-endpoint"), port: 43187, tls: true,
    hosts: ["192.168.1.5"], extensionPort: 9443 });
  tlsOnly.tlsActive = true;
  assert.equal(tlsOnly.endpointDescription(), "wss://192.168.1.5:9443/extension");
});

test("the CA download is not cacheable and carries the right content type", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "dsh-ca-headers-"));
  const bridge = new BrowserBridge({ home: path.join(root, "bridge"), port: 0 });
  try {
    bridge.tlsActive = true;
    bridge.ca = { caDer: Buffer.from("stub") };
    const response = await request(bridge, { pathname: `/ca.crt?k=${bridge.manageSecret}` });
    assert.equal(response.status, 200);
    assert.equal(response.headers["Content-Type"], "application/x-x509-ca-cert");
    assert.equal(response.headers["Cache-Control"], "no-store", "the header used to be misspelled as Content-Cache");
    assert.equal(response.headers["Content-Length"], 4);
    const denied = await request(bridge, { pathname: "/ca.crt" });
    assert.equal(denied.status, 404, "without the secret nothing is served");
  } finally {
    await bridge.close().catch(() => {});
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("the management cookie is Secure when the request arrived over TLS", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "dsh-cookie-"));
  const bridge = new BrowserBridge({ home: path.join(root, "bridge"), port: 0 });
  try {
    const overTls = await request(bridge, { pathname: `/setup?k=${bridge.manageSecret}`, secure: true });
    assert.match(overTls.headers["Set-Cookie"], /HttpOnly/);
    assert.match(overTls.headers["Set-Cookie"], /SameSite=Strict/);
    assert.match(overTls.headers["Set-Cookie"], /; Secure$/, "a TLS response must not hand out a cookie usable in the clear");

    const loopback = await request(bridge, { pathname: `/setup?k=${bridge.manageSecret}`, secure: false });
    assert.equal(loopback.headers["Set-Cookie"].includes("Secure"), false, "plain loopback would drop a Secure cookie");
  } finally {
    await bridge.close().catch(() => {});
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("guessing the management secret is throttled, but a valid secret still works", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "dsh-throttle-"));
  const bridge = new BrowserBridge({ home: path.join(root, "bridge"), port: 0 });
  try {
    const statuses = [];
    for (let index = 0; index < 12; index += 1) {
      statuses.push((await request(bridge, { pathname: "/manage", remoteAddress: "203.0.113.55" })).status);
    }
    assert.deepEqual(statuses.slice(0, 10), Array(10).fill(404), "the first misses stay indistinguishable from a missing page");
    assert.equal(statuses[10], 429, "after ten misses the peer cools down");
    assert.equal(statuses[11], 429);
    const cooled = await request(bridge, { pathname: "/manage", remoteAddress: "203.0.113.55" });
    assert.equal(cooled.headers["Retry-After"], "60");

    // A peer that knows the secret is never throttled, and a different peer is unaffected.
    const allowed = await request(bridge, { pathname: `/manage?k=${bridge.manageSecret}`, remoteAddress: "203.0.113.55" });
    assert.equal(allowed.status, 200, "a correct secret always works");
    assert.equal((await request(bridge, { pathname: "/manage", remoteAddress: "203.0.113.56" })).status, 404,
      "throttling is per peer");
  } finally {
    await bridge.close().catch(() => {});
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});
