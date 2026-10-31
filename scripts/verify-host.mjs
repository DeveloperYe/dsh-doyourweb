#!/usr/bin/env node
/**
 * Host smoke test for a machine running the DSH desktop app (or any DSH host).
 *
 * The plugin's host half is plain ESM for Node: no native addons, no web-only
 * services. This script proves that on the machine in question — it starts the
 * bridge exactly as the plugin does, generates the companion extension, and (when
 * TLS is enabled) checks that the certificate it mints passes a real handshake.
 *
 *   npm run verify:host            # default: loopback, plain
 *   npm run verify:host -- --tls   # also exercise the in-process TLS listener
 */
import os from "node:os";
import path from "node:path";
import tls from "node:tls";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { BrowserBridge } from "../src/bridge.js";

const wantTls = process.argv.includes("--tls");
const results = [];
const record = (label, ok, detail) => { results.push({ label, ok, detail }); console.log(`${ok ? "✔" : "✖"} ${label}${detail ? ` — ${detail}` : ""}`); };

console.log(`host: node ${process.version} · ${process.platform}/${process.arch}` +
  `${process.versions.electron ? ` · electron ${process.versions.electron}` : ""}`);
console.log(`cwd : ${process.cwd()}`);

// Dependencies resolve from the plugin's own node_modules, which is what an
// Electron main process will do as well.
// The MCP SDK only exposes deep paths, which is exactly how the plugin imports it.
for (const name of ["ws", "zod", "node-forge", "playwright-core", "ajv", "cross-spawn",
  "@modelcontextprotocol/sdk/client/index.js", "@modelcontextprotocol/sdk/client/stdio.js"]) {
  try { await import(name); record(`dependency ${name}`, true); }
  catch (error) { record(`dependency ${name}`, false, error.message); }
}

const home = await mkdtemp(path.join(os.tmpdir(), "dsh-verify-host-"));
const bridge = new BrowserBridge({ home: path.join(home, "bridge"), port: 0, autoBuild: true,
  tls: wantTls, hosts: [] });
try {
  await bridge.start();
  record("bridge listens", true, `127.0.0.1:${bridge.port}`);
  record("companion extension generated", bridge.extensionBuilds.length > 0,
    bridge.extensionBuilds.map(build => `${build.label} → ${build.endpoint}`).join(", "));
  for (const build of bridge.extensionBuilds) {
    const config = await readFile(path.join(build.dir, "config.js"), "utf8");
    record(`  ${build.label}: config.js + zip`, /"token":"[0-9a-f]{64}"/.test(config) && (await stat(build.zip)).size > 0);
  }
  const page = await fetch(bridge.manageUrl());
  record("management page served with the per-start secret", page.status === 200, `HTTP ${page.status}`);
  record("management page refuses anonymous access",
    (await fetch(`http://127.0.0.1:${bridge.port}/manage`)).status === 404);
  if (wantTls) {
    const caPem = await readFile(path.join(bridge.home, "tls", "ca.pem"), "utf8");
    record("TLS listener up", bridge.tlsActive, `port ${bridge.tlsPort}`);
    const ok = await new Promise(resolve => {
      const socket = tls.connect({ host: "127.0.0.1", port: bridge.tlsPort, servername: "localhost", ca: caPem }, () => {
        resolve(socket.authorized); socket.end();
      });
      socket.on("error", () => resolve(false));
    });
    record("certificate minted here verifies against the local CA", ok);
  }
} catch (error) {
  record("bridge start", false, error.message);
} finally {
  await bridge.close();
  await rm(home, { recursive: true, force: true });
}

const failed = results.filter(item => !item.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
