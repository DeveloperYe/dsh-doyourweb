import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createServer } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { BrowserBridge } from "../src/bridge.js";

async function occupy() {
  const server = createServer();
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  return { server, port: server.address().port, close: () => new Promise(resolve => server.close(resolve)) };
}

test("a busy default port falls back to an ephemeral one so web and desktop coexist", async () => {
  const taken = await occupy();
  const root = await mkdtemp(path.join(os.tmpdir(), "dsh-port-fallback-"));
  const bridge = new BrowserBridge({ home: path.join(root, "bridge"), port: taken.port, portFallback: true });
  try {
    await bridge.start();
    assert.equal(bridge.portFallbackUsed, true, "the fallback must be reported");
    assert.notEqual(bridge.port, taken.port);
    // The generated extension embeds the port actually used, so nothing else changes.
    const [build] = bridge.extensionBuilds;
    assert.match(build.endpoint, new RegExp(`:${bridge.port}/extension$`));
    assert.match(await readFile(path.join(build.dir, "config.js"), "utf8"), new RegExp(`"port":${bridge.port}`));
  } finally {
    await bridge.close();
    await taken.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("an explicitly configured port still fails loudly instead of drifting", async () => {
  const taken = await occupy();
  const root = await mkdtemp(path.join(os.tmpdir(), "dsh-port-strict-"));
  const bridge = new BrowserBridge({ home: path.join(root, "bridge"), port: taken.port, portFallback: false });
  try {
    await assert.rejects(() => bridge.start(), /already in use/);
  } finally {
    await bridge.close();
    await taken.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("a busy TLS port falls back to an ephemeral one too", async () => {
  const taken = await occupy();
  const root = await mkdtemp(path.join(os.tmpdir(), "dsh-tlsport-fallback-"));
  const bridge = new BrowserBridge({ home: path.join(root, "bridge"), port: 0, bind: "127.0.0.1",
    hosts: ["browser.example.com"], tls: true, tlsPort: taken.port, tlsPortFallback: true });
  try {
    await bridge.start();
    assert.equal(bridge.tlsPortFallbackUsed, true);
    assert.notEqual(bridge.tlsPort, taken.port);
    const published = bridge.extensionBuilds.find(build => build.label === "browser.example.com");
    assert.ok(published, "a wss build must exist for the allowlisted host");
    assert.match(published.endpoint, new RegExp(`:${bridge.tlsPort}/extension$`),
      "the published port follows the port actually bound");
  } finally {
    await bridge.close();
    await taken.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("an explicitly configured TLS port fails loudly", async () => {
  const taken = await occupy();
  const root = await mkdtemp(path.join(os.tmpdir(), "dsh-tlsport-strict-"));
  const bridge = new BrowserBridge({ home: path.join(root, "bridge"), port: 0, bind: "127.0.0.1",
    hosts: ["browser.example.com"], tls: true, tlsPort: taken.port, tlsPortFallback: false });
  try {
    await assert.rejects(() => bridge.start(), /TLS port .* already in use/);
  } finally {
    await bridge.close();
    await taken.close();
    await rm(root, { recursive: true, force: true });
  }
});
