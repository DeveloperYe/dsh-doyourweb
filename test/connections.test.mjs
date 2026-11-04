import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
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

const UAS = {
  edge: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.3537.71",
  chrome: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.7339.186 Safari/537.36",
};

async function connect(bridge, { ua, profile, session, tabs }) {
  const socket = new WebSocket(`ws://127.0.0.1:${bridge.port}/extension`, ["dsh-browser", bridge.settings.token],
    { headers: { Origin: `chrome-extension://${bridge.id}`, "User-Agent": ua } });
  await once(socket, "open");
  socket.send(JSON.stringify({ method: "dsh.inventory", params: { profile, browserSession: session,
    browser: ua.includes("Edg/") ? "Edge" : "Chrome",
    tabs: tabs.map(id => ({ id, title: `Tab ${id}`, url: `https://example.test/${id}`, windowId: 1 })) } }));
  return socket;
}

test("connections.json names each live browser so duplicates are visible without the secret", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "dsh-connections-"));
  const home = path.join(root, "bridge");
  const bridge = new BrowserBridge({ home, port: 0, heartbeatMs: 4000 });
  try {
    await bridge.start();
    const edge = await connect(bridge, { ua: UAS.edge, profile: "profile-edge", session: "session-edge", tabs: [1, 2] });
    const chrome = await connect(bridge, { ua: UAS.chrome, profile: "profile-chrome", session: "session-chrome", tabs: [3] });
    const file = path.join(home, "connections.json");
    assert.ok(await until(() => bridge.describeConnections().filter(row => row.tabs > 0).length === 2),
      "both sockets are tracked and have published their tabs");
    await bridge.connectionWrites; // the snapshot is written asynchronously
    const snapshot = JSON.parse(await readFile(file, "utf8"));
    assert.equal(snapshot.connections.length, 2);
    const [first, second] = snapshot.connections;
    assert.equal(first.browser, "Edge");
    assert.equal(first.version, "141.0.3537.71", "the Edge version comes from the handshake UA");
    assert.equal(first.profile, "profile-", "only a short profile id is exposed");
    assert.equal(first.tabs, 2);
    assert.equal(second.browser, "Chrome");
    assert.equal(second.tabs, 1);
    assert.match(second.version, /^140\./);
    assert.ok(first.connectedSeconds >= 0 && first.idleSeconds >= 0);

    edge.close();
    assert.ok(await until(() => bridge.describeConnections().length === 1), "a closed socket leaves the list");
    await bridge.connectionWrites;
    const after = JSON.parse(await readFile(file, "utf8"));
    assert.equal(after.connections[0].browser, "Chrome", "the snapshot follows the live set");
    chrome.close();
  } finally {
    await bridge.close().catch(() => {});
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("the setup page lists the connected browsers", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "dsh-connections-page-"));
  const bridge = new BrowserBridge({ home: path.join(root, "bridge"), port: 0, heartbeatMs: 4000 });
  try {
    await bridge.start();
    const one = await connect(bridge, { ua: UAS.edge, profile: "profile-edge", session: "session-edge", tabs: [1] });
    const two = await connect(bridge, { ua: UAS.chrome, profile: "profile-chrome", session: "session-chrome", tabs: [3, 4] });
    assert.ok(await until(() => bridge.describeConnections().filter(row => row.tabs > 0).length === 2));
    const html = await (await fetch(bridge.setupUrl())).text();
    assert.match(html, /已连接的浏览器/, "the table is rendered");
    assert.match(html, /Edge 141/, "the Edge instance is named with its version");
    assert.match(html, /Chrome 140/, "the Chrome instance is named");
    assert.match(html, /多条记录说明装了好几份扩展/, "several rows explain what they mean");
    assert.equal(html.includes(bridge.manageSecret), false, "the page still never repeats the secret");
    one.close();
    two.close();
  } finally {
    await bridge.close().catch(() => {});
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});
