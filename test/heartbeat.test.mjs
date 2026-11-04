import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { WebSocket } from "ws";
import { BrowserBridge } from "../src/bridge.js";

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { if (predicate()) return true; await sleep(25); }
  return false;
}
async function withBridge(options, run) {
  const root = await mkdtemp(path.join(os.tmpdir(), "dsh-heartbeat-"));
  const bridge = new BrowserBridge({ home: path.join(root, "bridge"), port: 0, ...options });
  try { await bridge.start(); await run(bridge); }
  finally { await bridge.close().catch(() => {}); await rm(root, { recursive: true, force: true }); }
}
async function connectExtension(bridge, { session = `s${Date.now().toString(16)}` } = {}) {
  const socket = new WebSocket(`ws://127.0.0.1:${bridge.port}/extension`, ["dsh-browser", bridge.settings.token],
    { headers: { Origin: `chrome-extension://${bridge.id}` } });
  await once(socket, "open");
  socket.send(JSON.stringify({ method: "dsh.inventory", params: { profile: "heartbeat", browserSession: session,
    browser: "test", tabs: [{ id: 1, title: "Tab", url: "https://example.test/", windowId: 1 }] } }));
  assert.ok(await until(() => bridge.list().length >= 1), "the extension must publish its tab");
  return socket;
}

test("silence in application messages reaps the socket (browser-level pongs cannot fake it)", async () => {
  await withBridge({ heartbeatMs: 120 }, async bridge => {
    const socket = await connectExtension(bridge);
    // Say nothing: the browser still answers ws pings, which is exactly why liveness
    // must come from the extension's own messages.
    assert.ok(await until(() => bridge.list().length === 0), "a silent worker must be dropped");
    assert.notEqual(socket.readyState, WebSocket.OPEN);
  });
});

test("an extension that keeps pinging stays connected", async () => {
  await withBridge({ heartbeatMs: 120 }, async bridge => {
    const socket = await connectExtension(bridge);
    const keep = setInterval(() => { if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ method: "dsh.ping" })); }, 80);
    try {
      await sleep(700); // several sweeps
      assert.equal(bridge.list().length, 1, "the tab stays addressable while the extension talks");
    } finally { clearInterval(keep); }
    socket.close();
    assert.ok(await until(() => bridge.list().length === 0), "a clean close still drops the profile");
  });
});

test("a reconnecting worker replaces the superseded connection instead of stacking", async () => {
  await withBridge({ heartbeatMs: 4000 }, async bridge => {
    const first = await connectExtension(bridge, { session: "same-session" });
    const second = await connectExtension(bridge, { session: "same-session" });
    assert.equal(bridge.list().length, 1, "one published tab, not two");
    assert.ok(await until(() => first.readyState !== WebSocket.OPEN), "the superseded socket is terminated, not left hanging");
    second.close();
  });
});

test("browser_open picks the most recently active browser when a reconnect is still settling", async () => {
  await withBridge({ heartbeatMs: 4000 }, async bridge => {
    const now = Date.now();
    const stale = { id: "stale", sourceId: "stale", sessionId: "stale", tabs: new Map(), browser: "Chrome", ws: { readyState: 1, lastSeen: now - 10000 } };
    const fresh = { id: "fresh", sourceId: "fresh", sessionId: "fresh", tabs: new Map(), browser: "Chrome", ws: { readyState: 1, lastSeen: now } };
    bridge.profiles.set("stale", stale);
    bridge.profiles.set("fresh", fresh);
    let target;
    bridge.request = async (profile, method, params) => {
      target = profile;
      setTimeout(() => fresh.tabs.set(11, { id: 11, ref: "dsh-browser://fresh/11", title: "Opened", url: params[1].url, browser: "Chrome" }), 20);
      return { tabId: 11 };
    };
    const opened = await bridge.openTab(undefined, "https://example.com/");
    assert.equal(target, fresh, "the freshest connection owns the browser now");
    assert.equal(opened.ref, "dsh-browser://fresh/11");
  });
});
