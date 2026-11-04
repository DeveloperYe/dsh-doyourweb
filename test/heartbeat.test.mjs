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

/** Connect like a paired extension and publish one tab. Ids must match the bridge's pattern. */
async function connectExtension(bridge, { autoPong = true, session = `s${Date.now().toString(16)}` } = {}) {
  const socket = new WebSocket(`ws://127.0.0.1:${bridge.port}/extension`, ["dsh-browser", bridge.settings.token],
    { headers: { Origin: `chrome-extension://${bridge.id}` }, autoPong });
  await once(socket, "open");
  socket.send(JSON.stringify({ method: "dsh.inventory", params: { profile: "heartbeat", browserSession: session,
    browser: "test", tabs: [{ id: 1, title: "Tab", url: "https://example.test/", windowId: 1 }] } }));
  assert.ok(await until(() => bridge.list().length === 1), "the extension must publish its tab");
  return socket;
}

test("the bridge reaps a half-open extension socket instead of leaking it", async () => {
  await withBridge({ heartbeatMs: 120 }, async bridge => {
    const socket = await connectExtension(bridge, { autoPong: false });
    // The service worker was suspended: TCP stays open but nothing answers pings.
    assert.ok(await until(() => bridge.list().length === 0), "a silent connection must be dropped");
    assert.notEqual(socket.readyState, WebSocket.OPEN);
  });
});

test("a responsive extension keeps its connection and tabs across heartbeat rounds", async () => {
  await withBridge({ heartbeatMs: 120 }, async bridge => {
    const socket = await connectExtension(bridge);
    await sleep(600); // five rounds
    assert.equal(bridge.list().length, 1, "auto-ponging clients are never reaped");
    socket.close();
    assert.ok(await until(() => bridge.list().length === 0), "a clean close still drops the profile");
  });
});

test("a reconnecting worker replaces the previous profile instead of stacking", async () => {
  await withBridge({ heartbeatMs: 120 }, async bridge => {
    const first = await connectExtension(bridge, { session: "same-session" });
    const second = await connectExtension(bridge, { session: "same-session" });
    // Same browser name replaces the stale profile, so browser_open never sees two.
    assert.equal(bridge.list().length, 1, "one published tab, not two");
    first.close();
    second.close();
  });
});
