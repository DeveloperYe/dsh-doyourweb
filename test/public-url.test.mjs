import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { BrowserBridge } from "../src/bridge.js";

const make = overrides => new BrowserBridge({ home: path.join(os.tmpdir(), "dsh-public-url"), port: 0, ...overrides });

test("one publicUrl supplies the dialled port, the Host allowlist entry and the scheme", () => {
  const bridge = make({ publicUrl: "https://203.0.113.10:9443", tls: true, bind: "0.0.0.0", remote: true });
  assert.equal(bridge.extensionPort, 9443, "the extension dials the port the outside world sees");
  assert.ok(bridge.hosts.includes("203.0.113.10"), "its Host header must pass the allowlist");
  assert.equal(bridge.extensionScheme, "wss", "an https public URL means TLS on the wire");
  // Host + port of the public URL must be answerable, or the handshake is rejected.
  assert.equal(bridge.hostAllowed("203.0.113.10:9443"), true);
  const profile = bridge.extensionProfiles().find(entry => entry.host === "203.0.113.10");
  assert.ok(profile, "a ready-made extension is generated for it");
  assert.equal(profile.scheme, "wss");
  assert.equal(profile.port, 9443);
});

test("explicit settings always win over the derivation", () => {
  const bridge = make({ publicUrl: "https://browser.example.test:9443", extensionPort: 39066, extensionScheme: "ws", hosts: ["other.example.test"] });
  assert.equal(bridge.extensionPort, 39066, "an explicit external port is kept");
  assert.deepEqual(bridge.hosts, ["other.example.test", "browser.example.test"], "the public host is added, not substituted");
});

test("a hostname public URL works the same way as an address", () => {
  const bridge = make({ publicUrl: "https://browser.example.test", tls: true, remote: true });
  bridge.tlsActive = true; // set by start() once the TLS listener is up
  assert.equal(bridge.hostAllowed("browser.example.test:8443"), true, "no explicit port means the TLS port is used");
  const profile = bridge.extensionProfiles().find(entry => entry.host === "browser.example.test");
  assert.equal(profile.port, 8443, "it falls back to tlsPort");
});

test("without publicUrl nothing changes: loopback only, no derived values", () => {
  const bridge = make({});
  assert.equal(bridge.publicUrl, undefined);
  assert.equal(bridge.extensionPort, undefined);
  assert.deepEqual(bridge.hosts, []);
  assert.equal(bridge.hostAllowed("203.0.113.10:8443"), false, "an unlisted host stays rejected");
  assert.equal(bridge.hostAllowed("127.0.0.1:43187"), false, "port 0 is not dialable until start()");
});
