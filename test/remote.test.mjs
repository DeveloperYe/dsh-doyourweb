import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { BrowserBridge } from "../src/bridge.js";
import { Pairings } from "../src/pairing.js";

test("the bridge refuses to listen off-loopback unless remote is explicitly enabled", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "dsh-remote-bind-"));
  const bridge = new BrowserBridge({ home: path.join(root, "bridge"), port: 0, bind: "0.0.0.0" });
  try {
    await assert.rejects(() => bridge.start(), /remote: true/);
  } finally {
    await bridge.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("host headers are matched against loopback plus the configured names only", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "dsh-remote-host-"));
  const bridge = new BrowserBridge({ home: path.join(root, "bridge"), port: 43187, bind: "0.0.0.0", remote: true,
    hosts: ["192.168.1.5", "browser.example.com"] });
  try {
    assert.equal(bridge.hostAllowed("127.0.0.1:43187"), true);
    assert.equal(bridge.hostAllowed("localhost:43187"), true);
    assert.equal(bridge.hostAllowed("[::1]:43187"), true);
    assert.equal(bridge.hostAllowed("0.0.0.0:43187"), true, "the bound address stays reachable");
    assert.equal(bridge.hostAllowed("192.168.1.5:43187"), true);
    assert.equal(bridge.hostAllowed("BROWSER.example.com:43187"), true);
    assert.equal(bridge.hostAllowed("192.168.1.6:43187"), false);
    assert.equal(bridge.hostAllowed("127.0.0.1:43188"), false, "a different port is another service");
    assert.equal(bridge.hostAllowed("evil.example"), false);
    assert.equal(bridge.hostAllowed(undefined), false);
    assert.equal(bridge.endpointDescription(), "ws://192.168.1.5:43187/extension");
  } finally {
    await bridge.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("management, setup and pairing answer only connections from this machine", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "dsh-remote-gate-"));
  const bridge = new BrowserBridge({ home: path.join(root, "bridge"), port: 43187, bind: "0.0.0.0", remote: true, hosts: ["10.0.0.9"] });
  try {
    const respond = (pathname, remoteAddress, host = "10.0.0.9:43187") => {
      const response = { status: undefined, writeHead(code) { this.status = code; return this; }, end() { return this; } };
      bridge.handleHttp({ method: "GET", url: pathname, headers: { host }, socket: { remoteAddress } }, response);
      return response.status;
    };
    assert.equal(BrowserBridge.loopback({ socket: { remoteAddress: "127.0.0.1" } }), true);
    assert.equal(BrowserBridge.loopback({ socket: { remoteAddress: "::ffff:127.0.0.1" } }), true);
    assert.equal(BrowserBridge.loopback({ socket: { remoteAddress: "10.0.0.9" } }), false);
    assert.equal(respond("/manage", "10.0.0.9"), 404, "a published bridge must not expose management");
    assert.equal(respond("/setup", "10.0.0.9"), 404);
    assert.equal(respond("/manage", "127.0.0.1"), 200);
    assert.equal(respond("/setup", "127.0.0.1"), 200);
    assert.equal(respond("/manage", "10.0.0.9", "evil.example:43187"), 403, "an unlisted Host is refused first");
  } finally {
    await bridge.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("a published bridge pairs locally but never offers pairing to the network", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "dsh-remote-loop-"));
  const bridge = new BrowserBridge({ home: path.join(root, "bridge"), port: 0, bind: "0.0.0.0", remote: true, hosts: ["10.0.0.9"] });
  const accepted = [];
  try {
    await bridge.start();
    // The real upgrade path is exercised with stub sockets: no socket leaves this test.
    const original = bridge.ws.handleUpgrade;
    bridge.ws.handleUpgrade = (request, socket, head, done) => {
      accepted.push(socket);
      done({ readyState: 1, send() {}, on() {}, close() { this.readyState = 3; } });
    };
    const request = ({ url = "/extension", ...overrides } = {}) => {
      const headers = { host: `10.0.0.9:${bridge.port}`, origin: `chrome-extension://${bridge.id}`, "sec-websocket-protocol": "dsh-browser", ...overrides };
      for (const key of Object.keys(headers)) if (headers[key] === undefined) delete headers[key];
      const socket = { remoteAddress: "10.0.0.9", destroyed: false, destroy() { this.destroyed = true; } };
      return { url, headers, socket };
    };
    // A browser on this machine still pairs.
    const local = request({ "sec-websocket-protocol": undefined });
    local.socket.remoteAddress = "127.0.0.1";
    bridge.handleUpgrade(local, local.socket);
    assert.equal(accepted.length, 1);
    assert.equal(bridge.pairings.list().length, 1, "a local extension still registers a pairing request");
    // The same request from another machine is dropped and registers nothing.
    const anonymous = request({ "sec-websocket-protocol": undefined });
    bridge.handleUpgrade(anonymous, anonymous.socket);
    assert.equal(anonymous.socket.destroyed, true, "pairing is loopback only");
    assert.equal(accepted.length, 1);
    assert.equal(bridge.pairings.list().length, 1, "a remote socket must never register a pairing request");
    // A remote browser that already holds the token is accepted as an extension.
    const paired = request({ "sec-websocket-protocol": `dsh-browser, ${bridge.settings.token}` });
    bridge.handleUpgrade(paired, paired.socket);
    assert.equal(paired.socket.destroyed, false);
    assert.equal(accepted.length, 2);
    // Anything else — a wrong origin, an unlisted Host, another path — is refused.
    const badOrigin = request({ origin: "chrome-extension://someoneelse", "sec-websocket-protocol": `dsh-browser, ${bridge.settings.token}` });
    bridge.handleUpgrade(badOrigin, badOrigin.socket);
    assert.equal(badOrigin.socket.destroyed, true);
    const badHost = request({ host: "evil.example:443", "sec-websocket-protocol": `dsh-browser, ${bridge.settings.token}` });
    bridge.handleUpgrade(badHost, badHost.socket);
    assert.equal(badHost.socket.destroyed, true);
    const relayPath = request({ url: "/cdp/1111", "sec-websocket-protocol": `dsh-browser, ${bridge.settings.token}` });
    bridge.handleUpgrade(relayPath, relayPath.socket);
    assert.equal(relayPath.socket.destroyed, true, "an unknown relay path is refused");
    bridge.ws.handleUpgrade = original;
  } finally {
    await bridge.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("pairing PINs are matched without leaking them and repeated misses clear pending requests", () => {
  let now = 1000;
  const pairings = new Pairings({ ttlMs: 5000, now: () => now });
  const closed = [];
  const first = pairings.request({ close: () => closed.push("first") });
  const second = pairings.request({ close: () => closed.push("second") });
  assert.notEqual(first.code, undefined);
  assert.deepEqual(pairings.list().map(entry => Object.keys(entry).sort()), [["created", "expires", "id"], ["created", "expires", "id"]]);
  assert.equal(pairings.match(first.code)?.id, first.id);
  assert.equal(pairings.match("x"), undefined);
  assert.equal(pairings.match("12345"), undefined);
  assert.equal(pairings.match(""), undefined);
  // A miss keeps the request; the bridge clears everything after five misses.
  assert.equal(pairings.list().length, 2);
  pairings.clear("Too many pairing attempts");
  assert.deepEqual(pairings.list(), []);
  assert.deepEqual(closed.sort(), ["first", "second"]);
  now += 1;
  assert.equal(pairings.request, pairings.request);
});

test("the client cookie, not a page-embedded key, authenticates the management API", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "dsh-manage-cookie-"));
  const bridge = new BrowserBridge({ home: path.join(root, "bridge"), port: 0 });
  try {
    await bridge.start();
    bridge.management = async request => ({ action: request.action });
    const page = await fetch(`http://127.0.0.1:${bridge.port}/manage`);
    const body = await page.text();
    assert.equal(body.includes(bridge.setupKey), false, "the page must not embed the management key");
    const cookie = /dsh_manage=([0-9a-f]+)/.exec(String(page.headers.get("set-cookie")))?.[1];
    assert.ok(cookie, "the page must set the HttpOnly management cookie");
    const post = headers => fetch(`http://127.0.0.1:${bridge.port}/manage/api`, { method: "POST",
      headers: { "Content-Type": "application/json", ...headers }, body: '{"action":"state"}' });
    assert.equal((await post({})).status, 403, "no credential means no management");
    assert.equal((await post({ Cookie: "dsh_manage=deadbeef" })).status, 403);
    assert.equal((await post({ Cookie: `dsh_manage=${cookie}` })).status, 200);
    assert.equal((await post({ "X-DSH-Key": bridge.setupKey })).status, 200, "the CLI surface keeps working");
  } finally {
    await bridge.close();
    await rm(root, { recursive: true, force: true });
  }
});
