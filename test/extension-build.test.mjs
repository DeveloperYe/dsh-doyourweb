import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import { BrowserBridge } from "../src/bridge.js";
import { extensionId } from "../src/pairing.js";
import { buildExtension, extensionProfiles, generateManifestKey, profileKey, zipDirectory } from "../src/extension-build.js";

const source = fileURLToPath(new URL("../extension", import.meta.url));

test("a generated manifest key yields a stable, distinct extension id", async () => {
  const first = generateManifestKey();
  const second = generateManifestKey();
  assert.match(first, /^MII[A-Za-z0-9+/=]+$/);
  assert.notEqual(first, second);
  assert.match(extensionId(first), /^[a-p]{32}$/);
  assert.equal(extensionId(first), extensionId(first));
});

test("endpoint profiles cover loopback, the bind address, hosts and explicit overrides", () => {
  const local = extensionProfiles({ port: 43187 });
  assert.deepEqual(local.map(entry => entry.key), ["ws-127.0.0.1-43187"]);
  assert.equal(local[0].label, "本机");

  const published = extensionProfiles({ bind: "0.0.0.0", port: 43187, hosts: ["192.168.1.5", "browser.example.com"], scheme: "wss" });
  assert.deepEqual(published.map(entry => entry.host), ["127.0.0.1", "192.168.1.5", "browser.example.com"]);
  assert.equal(published[0].scheme, "ws", "the loopback copy stays plain ws");
  assert.equal(published[2].scheme, "wss", "a published host follows the configured scheme");

  const tunnelled = extensionProfiles({ port: 43187, hosts: ["browser.example.com"], scheme: "wss", publicPort: 443 });
  assert.equal(tunnelled[1].port, 443);
  assert.equal(tunnelled[1].key, "wss-browser.example.com-443");

  const overridden = extensionProfiles({ port: 43187, profiles: [{ label: "家里 NAS", host: "10.0.0.9", port: 5000, scheme: "ws" }] });
  assert.deepEqual(overridden.at(-1), { label: "家里 NAS", scheme: "ws", host: "10.0.0.9", port: 5000, key: "ws-10.0.0.9-5000" });
  const raw = profileKey({ scheme: "ws", host: "[::1]", port: 1 });
  assert.match(raw, /^[A-Za-z0-9._-]+$/, "a profile key must be safe as a directory name");
  assert.deepEqual(extensionProfiles({ bind: "10.0.0.9", port: 43187 }).map(entry => entry.host), ["127.0.0.1", "10.0.0.9"]);
  assert.deepEqual(extensionProfiles({ bind: "0.0.0.0", port: 43187 }).map(entry => entry.host), ["127.0.0.1"],
    "a wildcard bind adds no profile of its own");
});

test("a built extension carries its endpoint and token and is a loadable folder", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "dsh-build-ext-"));
  const token = "a".repeat(64);
  const key = generateManifestKey();
  try {
    const profile = { label: "browser.example.com", scheme: "wss", host: "browser.example.com", port: 443, key: "wss-browser.example.com-443" };
    const built = await buildExtension({ source, outDir: path.join(root, "ext"), profile, token, key, version: "9.9.9", title: "DSH DoYourWeb" });
    const files = (await readdir(built.dir)).sort();
    assert.deepEqual(files, ["APACHE-2.0.txt", "annotator.js", "background.js", "config.js", "icons", "manifest.json", "popup.html", "popup.js"]);
    const config = await readFile(path.join(built.dir, "config.js"), "utf8");
    assert.match(config, /"scheme":"wss"/);
    assert.match(config, /"host":"browser\.example\.com"/);
    assert.match(config, /"port":443/);
    assert.ok(config.includes(token), "the generated copy is already paired");
    assert.ok(!config.includes('token":""'), "never ship an empty token");
    const manifest = JSON.parse(await readFile(path.join(built.dir, "manifest.json"), "utf8"));
    assert.equal(manifest.manifest_version, 3);
    assert.equal(manifest.version, "9.9.9");
    assert.equal(manifest.key, key, "the per-installation key is what gives this copy its own id");
    assert.match(manifest.name, /browser\.example\.com/);
    assert.equal(extensionId(manifest.key), (await import("../src/pairing.js")).pinnedExtensionId(manifest));
    assert.equal(built.endpoint, "wss://browser.example.com:443/extension");
    // The source template is never touched.
    assert.equal(JSON.parse(await readFile(path.join(source, "manifest.json"), "utf8")).key.length > 0, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the generated zip is a real archive a user can unzip", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "dsh-build-zip-"));
  try {
    const profile = { label: "本机", scheme: "ws", host: "127.0.0.1", port: 43187, key: "ws-127.0.0.1-43187" };
    const built = await buildExtension({ source, outDir: path.join(root, "ext"), profile, token: "b".repeat(64),
      key: generateManifestKey(), version: "9.9.9" });
    const zip = await zipDirectory(built.dir, path.join(root, "ext.zip"));
    assert.ok(zip.entries >= 8);
    const bytes = await readFile(zip.file);
    assert.equal(bytes.readUInt32LE(0), 0x04034b50, "local file header signature");
    // Read the first entry back through zlib and compare it with the file on disk.
    const method = bytes.readUInt16LE(8), size = bytes.readUInt32LE(18), nameLength = bytes.readUInt16LE(26);
    const extraLength = bytes.readUInt16LE(28);
    const name = bytes.subarray(30, 30 + nameLength).toString("utf8");
    const body = bytes.subarray(30 + nameLength + extraLength, 30 + nameLength + extraLength + size);
    const unpacked = method === 8 ? zlib.inflateRawSync(body) : body;
    assert.deepEqual(unpacked, await readFile(path.join(built.dir, name)));
    // Cross-check with the platform unzip: libarchive in tar reads zip on Windows too.
    const listing = execFileSync("tar", ["-tf", zip.file], { encoding: "utf8" });
    assert.match(listing, /manifest\.json/);
    assert.match(listing, /config\.js/);
    assert.ok((await stat(zip.file)).size < 200 * 1024);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the bridge generates one extension per endpoint and serves it over loopback only", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "dsh-build-bridge-"));
  const bridge = new BrowserBridge({ home: path.join(root, "home"), port: 0, bind: "0.0.0.0", remote: true, hosts: ["10.0.0.9"] });
  try {
    await bridge.start();
    assert.equal(bridge.extensionBuilds.length, 2, "loopback plus the published host");
    const [local, published] = bridge.extensionBuilds;
    assert.equal(local.endpoint, `ws://127.0.0.1:${bridge.port}/extension`);
    assert.equal(published.endpoint, "ws://10.0.0.9:43187/extension".replace("43187", String(bridge.port)));
    for (const build of bridge.extensionBuilds) {
      assert.match(build.id, /^[a-p]{32}$/);
      assert.ok((await stat(build.zip)).size > 0);
    }
    const download = await fetch(`http://127.0.0.1:${bridge.port}/extension.zip?p=${encodeURIComponent(local.key)}`);
    assert.equal(download.status, 200);
    assert.equal(download.headers.get("content-type"), "application/zip");
    assert.equal((await download.arrayBuffer()).byteLength, local.bytes);
    assert.equal((await fetch(`http://127.0.0.1:${bridge.port}/extension.zip?p=nope`)).status, 404);
    // A remote peer never reaches the token-bearing archive.
    const response = { status: undefined, writeHead(code) { this.status = code; return this; }, end() { return this; } };
    await bridge.handleHttp({ method: "GET", url: `/extension.zip?p=${local.key}`, headers: { host: `10.0.0.9:${bridge.port}` },
      socket: { remoteAddress: "10.0.0.9" } }, response);
    assert.equal(response.status, 404);
    // Rebuilding is idempotent: the marker short-circuits an unchanged config.
    const builtAt = await readFile(path.join(bridge.extensionOutDir, "build.json"), "utf8");
    await bridge.buildExtensions();
    assert.equal(await readFile(path.join(bridge.extensionOutDir, "build.json"), "utf8"), builtAt);
    const forced = await bridge.buildExtensions({ force: true });
    assert.notEqual(await readFile(path.join(bridge.extensionOutDir, "build.json"), "utf8"), builtAt);
    assert.equal(forced.length, 2);
  } finally {
    await bridge.close();
    await rm(root, { recursive: true, force: true });
  }
});
