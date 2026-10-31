import { createHash, generateKeyPairSync } from "node:crypto";
import { copyFile, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import zlib from "node:zlib";

/**
 * Generated companion extensions.
 *
 * The stock `extension/` folder is a template the user loads by hand: it knows no
 * endpoint and no token, so it has to pair. After installation the bridge knows
 * both, so it can materialise a ready-to-load copy per endpoint — correct host,
 * scheme, port, a per-installation manifest key and the pairing token baked in.
 * Loading that folder in Chrome or Edge is the whole setup.
 */

const CA_FILE = "ca.crt";

const COPIED = ["annotator.js", "background.js", "popup.html", "popup.js", "APACHE-2.0.txt"];
const COPIED_DIRECTORIES = ["icons"];

/** A fresh RSA key in the base64 SPKI form a Chrome manifest `key` expects. */
export function generateManifestKey() {
  const { publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return publicKey.export({ type: "spki", format: "der" }).toString("base64");
}

export function profileKey(profile) {
  return `${profile.scheme}-${profile.host}-${profile.port}`.replace(/[^a-z0-9.-]+/gi, "_");
}

/**
 * Endpoints this install should offer, loopback first. `config.profiles` adds or
 * overrides entries; `hosts` from the remote settings produce ws/wss variants so a
 * remote machine gets an extension that already points at this bridge.
 */
export function extensionProfiles({ bind = "127.0.0.1", port = 43187, hosts = [], scheme = "ws", publicPort, profiles } = {}) {
  const entries = [{ label: "本机", scheme: "ws", host: "127.0.0.1", port }];
  // A wildcard bind is not an address anyone can dial, so only a concrete
  // non-loopback address becomes its own profile.
  const concrete = !["127.0.0.1", "::1", "localhost", "0.0.0.0", "::", ""].includes(String(bind).toLowerCase());
  if (concrete) entries.push({ label: `本机（${bind}）`, scheme: "ws", host: String(bind), port });
  for (const host of hosts) {
    const entry = { label: String(host), scheme: scheme === "wss" ? "wss" : "ws", host: String(host), port: publicPort || port };
    if (!entries.some(item => item.host === entry.host && item.port === entry.port && item.scheme === entry.scheme)) entries.push(entry);
  }
  for (const item of profiles || []) {
    if (!item || typeof item !== "object" || !item.host) continue;
    const entry = { label: String(item.label || item.host), scheme: item.scheme === "wss" ? "wss" : "ws",
      host: String(item.host), port: Number(item.port) || port };
    const index = entries.findIndex(existing => existing.host === entry.host && existing.port === entry.port);
    if (index >= 0) entries[index] = entry; else entries.push(entry);
  }
  return entries.map(entry => ({ ...entry, key: profileKey(entry) }));
}

async function copyTree(from, to, prefix = "", written = []) {
  await mkdir(to, { recursive: true });
  for (const entry of await readdir(from, { withFileTypes: true })) {
    const source = path.join(from, entry.name);
    const target = path.join(to, entry.name);
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) await copyTree(source, target, relative, written);
    else if (entry.isFile()) { await copyFile(source, target); written.push(relative); }
  }
  return written;
}

/** Remove files that the current build no longer produces; a locked file is left alone. */
async function prune(root, keep, prefix = "") {
  const removed = [];
  for (const entry of await readdir(path.join(root, prefix), { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) { removed.push(...await prune(root, keep, relative)); continue; }
    if (keep.has(relative)) continue;
    try { await rm(path.join(root, relative), { force: true }); removed.push(relative); } catch { /* keep it */ }
  }
  return removed;
}

/**
 * Write one loadable extension for a single endpoint. Returns the folder, the
 * generated id and the files it contains; the caller decides where to advertise it.
 */
export async function buildExtension({ source, outDir, profile, token, key, version = "0.0.0", title, ca }) {
  if (!/^[0-9a-f]{64}$/.test(String(token ?? ""))) throw new Error("The pairing token is missing; start the bridge before generating an extension");
  const manifest = JSON.parse(await readFile(path.join(source, "manifest.json"), "utf8"));
  await mkdir(outDir, { recursive: true });
  const written = [];
  for (const file of COPIED) { await copyFile(path.join(source, file), path.join(outDir, file)); written.push(file); }
  for (const directory of COPIED_DIRECTORIES) await copyTree(path.join(source, directory), path.join(outDir, directory), directory, written);
  // The template config is replaced, never patched: an endpoint plus a token is the
  // only difference between this copy and the stock folder.
  const configValue = { scheme: profile.scheme, host: profile.host, port: profile.port, token };
  // A self-signed endpoint needs its CA trusted before wss:// can even handshake, so
  // the package carries it and the popup offers a one-click export. A browser
  // extension cannot write the trust store itself: that is an operating-system
  // operation with no extension API, so the last click stays with the user.
  if (ca?.der?.length) configValue.ca = CA_FILE;
  await writeFile(path.join(outDir, "config.js"), [
    "// Generated by dsh-doyourweb. This copy is already paired with one DSH install.",
    "// Treat it like a password: anyone holding this folder can control the tabs it",
    "// reaches. Do not commit it, sync it, or drop it in a shared directory.",
    `export const config = ${JSON.stringify(configValue)};`,
    "",
  ].join("\n"), { mode: 0o600 });
  const name = `${title || manifest.name}${profile.label === "本机" ? "" : ` · ${profile.label}`}`;
  const generated = { ...manifest, name, short_name: name.slice(0, 12), version, key };
  if (ca?.der?.length) {
    await writeFile(path.join(outDir, CA_FILE), ca.der, { mode: 0o644 });
    written.push(CA_FILE);
    generated.web_accessible_resources = [{ resources: [CA_FILE], matches: ["<all_urls>"] }];
  }
  await writeFile(path.join(outDir, "manifest.json"), `${JSON.stringify(generated, null, 2)}\n`);
  written.push("config.js", "manifest.json");
  const removed = await prune(outDir, new Set(written));
  return { dir: outDir, name, removed, config: { scheme: profile.scheme, host: profile.host, port: profile.port,
    ca: ca?.der?.length ? CA_FILE : undefined },
    endpoint: `${profile.scheme}://${profile.host.includes(":") && !profile.host.startsWith("[") ? `[${profile.host}]` : profile.host}:${profile.port}/extension` };
}

// --- minimal zip writer (deflate, no external dependency) -------------------

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let index = 0; index < 256; index++) {
    let value = index;
    for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[index] = value;
  }
  return table;
})();

function crc32(buffer) {
  let value = -1;
  for (const byte of buffer) value = CRC_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8);
  return (value ^ -1) >>> 0;
}

async function collect(root, prefix = "") {
  const files = [];
  for (const entry of await readdir(path.join(root, prefix), { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...await collect(root, relative));
    else if (entry.isFile()) files.push(relative);
  }
  return files;
}

/** Zip a directory so the folder can be handed to another machine unzipped. */
export async function zipDirectory(root, target) {
  const files = await collect(root);
  const locals = [], centrals = [];
  let offset = 0;
  for (const file of files) {
    const name = Buffer.from(file, "utf8");
    const data = await readFile(path.join(root, file));
    const packed = zlib.deflateRawSync(data);
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(8, 8); local.writeUInt16LE(0, 10); local.writeUInt16LE(0, 12);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(packed.length, 18); local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26); local.writeUInt16LE(0, 28);
    locals.push(local, name, packed);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8); central.writeUInt16LE(8, 10); central.writeUInt16LE(0, 12); central.writeUInt16LE(0, 14);
    central.writeUInt32LE(crc, 16); central.writeUInt32LE(packed.length, 20); central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28); central.writeUInt16LE(0, 30); central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34); central.writeUInt16LE(0, 36); central.writeUInt32LE(0, 38); central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += local.length + name.length + packed.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(0, 4); end.writeUInt16LE(0, 6);
  end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16); end.writeUInt16LE(0, 20);
  await writeFile(target, Buffer.concat([...locals, directory, end]), { mode: 0o600 });
  return { file: target, entries: files.length, bytes: (await stat(target)).size };
}

export function configFingerprint(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 16);
}
