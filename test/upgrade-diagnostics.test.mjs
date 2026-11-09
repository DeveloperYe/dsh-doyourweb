import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { WebSocket } from "ws";
import { BrowserBridge } from "../src/bridge.js";

const EXTENSION_ID = "abcdefghijklmnopabcdefghijklmnop";
const ORIGIN = `chrome-extension://${EXTENSION_ID}`;

async function bridge(t, options = {}) {
  const home = await mkdtemp(path.join(os.tmpdir(), "dsh-upgrades-"));
  const instance = new BrowserBridge({ home, port: 0, autoBuild: false, ...options });
  await instance.start();
  t.after(async () => { await instance.close(); await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); });
  return instance;
}

/** Try one upgrade and resolve once the client knows the outcome. */
function attempt(url, protocols, { origin, host } = {}) {
  return new Promise(resolve => {
    const socket = new WebSocket(url, protocols, {
      rejectUnauthorized: false, handshakeTimeout: 4000, origin,
      headers: host ? { Host: host } : undefined,
    });
    let done = false, opened = false;
    const finish = () => { if (done) return; done = true; try { socket.terminate(); } catch { /* gone */ } resolve({ opened }); };
    socket.on("open", () => { opened = true; finish(); });
    socket.on("error", finish);
    socket.on("close", finish);
    setTimeout(finish, 4200);
  });
}

const lastReason = (instance, accepted) => instance.upgradeLog.filter(e => e.accepted === accepted).at(-1)?.reason;

test("an accepted extension upgrade is recorded with its identity", async t => {
  const instance = await bridge(t);
  // The token is the one this install minted; the extension presents it as a subprotocol.
  instance.id = EXTENSION_ID;
  await attempt(`ws://127.0.0.1:${instance.port}/extension`, ["dsh-browser", instance.settings.token], { origin: ORIGIN });
  await new Promise(resolve => setTimeout(resolve, 400));
  assert.equal(lastReason(instance, true), "accepted");
});

test("each rejection records why, so an outage is diagnosable from the host side", async t => {
  const instance = await bridge(t);
  instance.id = EXTENSION_ID;

  await attempt(`ws://127.0.0.1:${instance.port}/extension`, ["dsh-browser", "0".repeat(64)], { origin: ORIGIN });
  await new Promise(resolve => setTimeout(resolve, 400));
  assert.equal(lastReason(instance, false), "token-mismatch", "a wrong token says so");

  await attempt(`ws://127.0.0.1:${instance.port}/extension`, ["dsh-browser"]);
  await new Promise(resolve => setTimeout(resolve, 400));
  assert.equal(lastReason(instance, false), "origin-not-trusted", "a missing Origin says so");

  // A token-less request from loopback with a trusted Origin is a pairing request, not a
  // rejection: that is how a freshly loaded stock extension asks for a PIN.
  const pairing = await attempt(`ws://127.0.0.1:${instance.port}/extension`, ["dsh-browser"], { origin: ORIGIN });
  assert.equal(pairing.opened, true, "loopback pairing is accepted");
  await new Promise(resolve => setTimeout(resolve, 400));
  assert.equal(lastReason(instance, false), "origin-not-trusted", "and it logged no rejection of its own");
});

test("the snapshot never carries the token itself", async t => {
  const instance = await bridge(t);
  instance.id = EXTENSION_ID;
  await attempt(`ws://127.0.0.1:${instance.port}/extension`, ["dsh-browser", instance.settings.token], { origin: ORIGIN });
  await new Promise(resolve => setTimeout(resolve, 600));

  const raw = await readFile(path.join(instance.home, "upgrades.json"), "utf8");
  assert.equal(raw.includes(instance.settings.token), false, "the secret stays out of the file");
  const parsed = JSON.parse(raw);
  const entry = parsed.entries.at(-1);
  assert.equal(entry.tokenLength, instance.settings.token.length, "only the length is kept");
  assert.equal(entry.accepted, true);
  assert.ok(parsed.entries.length >= 1);
});
