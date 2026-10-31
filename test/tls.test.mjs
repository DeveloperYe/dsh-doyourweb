import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { X509Certificate } from "node:crypto";
import os from "node:os";
import path from "node:path";
import tls from "node:tls";
import { WebSocket } from "ws";
import { BrowserBridge } from "../src/bridge.js";
import { ensureLocalCertificate, sanEntries } from "../src/tls.js";

test("SAN entries carry the configured names and addresses, loopback always present", () => {
  const entries = sanEntries(["browser.example.com", "10.1.2.3"], ["36.1.2.3", "not-an-ip"]);
  assert.deepEqual(entries.names.sort(), ["browser.example.com", "localhost"]);
  assert.deepEqual(entries.ips.sort(), ["10.1.2.3", "127.0.0.1", "36.1.2.3"]);
});

test("the plugin mints a CA and leaf that a TLS client accepts", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "dsh-tls-"));
  try {
    const material = await ensureLocalCertificate({ dir, hostnames: ["browser.example.com"], ips: ["36.1.2.3"] });
    const ca = new X509Certificate(material.caPem);
    const leaf = new X509Certificate(material.certPem);
    assert.equal(ca.ca, true, "the trust anchor must be a CA certificate");
    // Node's checkIssued also compares DN encodings; the criterion that matters is
    // OpenSSL's, asserted below with a real handshake that trusts only this CA.
    assert.equal(leaf.verify(ca.publicKey), true, "the CA signature must verify");
    assert.match(leaf.subjectAltName, /DNS:browser\.example\.com/);
    assert.match(leaf.subjectAltName, /IP Address:36\.1\.2\.3/);
    assert.match(leaf.subjectAltName, /IP Address:127\.0\.0\.1/);
    assert.ok(material.caDer.length > 400, "the DER form is exported for a one-click trust import");
    assert.ok(material.notAfter.getTime() > Date.now() + 300 * 24 * 60 * 60 * 1000, "397 days is the browser limit");

    // A second call reuses the same CA and leaf, so trust survives restarts.
    const again = await ensureLocalCertificate({ dir, hostnames: ["browser.example.com"], ips: ["36.1.2.3"] });
    assert.equal(again.renewed, false);
    assert.equal(again.caPem, material.caPem);
    assert.equal(again.certPem, material.certPem);

    // Adding a hostname re-issues the leaf against the same CA.
    const widened = await ensureLocalCertificate({ dir, hostnames: ["browser.example.com", "another.example.com"], ips: ["36.1.2.3"] });
    assert.equal(widened.renewed, true);
    assert.equal(widened.caPem, material.caPem, "the CA must not change on renewal");
    assert.match(widened.certPem, /BEGIN CERTIFICATE/);

    // The stored leaf really works as a server certificate.
    const server = tls.createServer({ cert: widened.certPem, key: widened.keyPem }, socket => socket.end("ok"));
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    await new Promise((resolve, reject) => {
      const socket = tls.connect({ host: "127.0.0.1", port: server.address().port, servername: "browser.example.com", ca: widened.caPem }, () => {
        assert.equal(socket.authorized, true);
        socket.end(); resolve();
      });
      socket.on("error", reject);
    });
    await new Promise(resolve => server.close(resolve));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a TLS-enabled bridge accepts the extension over wss and serves the CA", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "dsh-tls-bridge-"));
  const bridge = new BrowserBridge({ home: path.join(root, "bridge"), port: 0, bind: "127.0.0.1",
    hosts: ["browser.example.com"], tls: true, tlsPort: 0 });
  try {
    await bridge.start();
    assert.equal(bridge.tlsActive, true);
    const caPem = await readFile(path.join(bridge.home, "tls", "ca.pem"), "utf8");
    assert.match(caPem, /BEGIN CERTIFICATE/);
    // The generated extension points at the TLS port with wss.
    const published = bridge.extensionBuilds.find(build => build.label === "browser.example.com");
    assert.ok(published, `a wss build must exist: ${bridge.extensionBuilds.map(b => b.label).join(", ")}`);
    assert.equal(published.endpoint, `wss://browser.example.com:${bridge.tlsPort}/extension`);
    assert.match(await readFile(path.join(published.dir, "config.js"), "utf8"), /"scheme":"wss"/);

    // The package carries the CA so the popup can offer a one-click export. The
    // browser cannot install it by itself: no extension API writes the trust store.
    const shipped = await readFile(path.join(published.dir, "ca.crt"));
    assert.ok(shipped.length > 400, "the CA must travel inside the extension");
    const manifest = JSON.parse(await readFile(path.join(published.dir, "manifest.json"), "utf8"));
    assert.deepEqual(manifest.web_accessible_resources, [{ resources: ["ca.crt"], matches: ["<all_urls>"] }],
      "the popup can only reach the file through web_accessible_resources");
    assert.match(await readFile(path.join(published.dir, "config.js"), "utf8"), /"ca":"ca.crt"/);
    assert.match(await readFile(path.join(published.dir, "popup.js"), "utf8"), /install-ca/);

    // Chain validation against this CA is asserted above with tls.connect; here the
    // point is that the wss route works end to end, so the client skips the check.
    const socket = new WebSocket(`wss://127.0.0.1:${bridge.tlsPort}/extension`, ["dsh-browser", bridge.settings.token],
      { rejectUnauthorized: false, headers: { Origin: `chrome-extension://${bridge.id}` } });
    await once(socket, "open");
    const published2 = once(socket, "message");
    socket.send(JSON.stringify({ method: "dsh.inventory", params: { profile: "tls-profile", browserSession: "tls-one",
      browser: "Edge", tabs: [{ id: 5, title: "Over TLS", url: "https://example.com/", windowId: 1 }] } }));
    socket.send(JSON.stringify({ method: "dsh.ping" }));
    assert.equal(JSON.parse((await published2)[0]).method, "dsh.pong");
    assert.deepEqual(bridge.list().map(tab => tab.title), ["Over TLS"]);
    socket.close();

    // The listener really is TLS: a client that does not trust the CA is refused.
    await assert.rejects(async () => {
      await new Promise((resolve, reject) => {
        const raw = tls.connect({ host: "127.0.0.1", port: bridge.tlsPort, servername: "browser.example.com" }, () => { raw.end(); resolve(); });
        raw.on("error", reject);
      });
    }, /UNABLE_TO_VERIFY|self.signed|unable to verify/i);

    // The CA download needs the per-start secret, like every other management route.
    assert.equal((await fetch(`http://127.0.0.1:${bridge.port}/ca.crt`)).status, 404);
    const ca = await fetch(bridge.secretUrl("/ca.crt"));
    assert.equal(ca.status, 200);
    assert.equal(ca.headers.get("content-type"), "application/x-x509-ca-cert");
    assert.ok((await ca.arrayBuffer()).byteLength > 400);
  } finally {
    await bridge.close();
    await rm(root, { recursive: true, force: true });
  }
});
