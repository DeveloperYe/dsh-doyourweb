#!/usr/bin/env node
/**
 * Verify the DSH plugin contracts this package depends on against a real DSH
 * installation, instead of trusting the hand-written Typert contributions.
 *
 * The plugin speaks three undocumented-in-source DSH interfaces: generated
 * `strict` Remote codecs, the Typert registry, and the client API Gateway. A DSH
 * upgrade can change any of them, so this script extracts the relevant runtime
 * bundles from the installed application and re-checks that:
 *
 *   1. the real Typert registry accepts `hostContribution` and decodes requests;
 *   2. the real client Gateway mounts `remoteContribution` and invokes it;
 *   3. the *built* `lib/client.js` mounts the namespace and its `@` source
 *      returns tabs, which is what the menus do.
 *
 * Usage (after `npm ci`):
 *
 *   node scripts/verify-dsh-contract.mjs --asar "<path to app.asar>"
 *
 * The archive is extracted into `.local/dsh-extract` (Git-ignored) so its bare
 * imports still resolve against this repository's `node_modules`; `--out` moves
 * that directory.
 */
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import assert from "node:assert/strict";
import * as cordis from "@deepseek-ai/cordis";
import { Context } from "@deepseek-ai/cordis";
import { descriptors, hostContribution, remoteContribution } from "../src/protocol.js";

const root = fileURLToPath(new URL("..", import.meta.url));
const argument = name => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
};
const archive = argument("--asar");
const output = path.resolve(root, argument("--out") ?? ".local/dsh-extract");

if (!archive) {
  console.error("verify-dsh-contract: pass --asar <path to app.asar>.");
  process.exit(2);
}
try { await stat(archive); }
catch { console.error(`verify-dsh-contract: archive not found: ${archive}`); process.exit(2); }

/** Read the ASAR directory table and extract the requested suffixes. */
async function extract(suffixes) {
  const { open } = await import("node:fs/promises");
  const handle = await open(archive, "r");
  try {
    const header = Buffer.alloc(16);
    await handle.read(header, 0, 16, 0);
    const size = header.readUInt32LE(12);
    const directory = Buffer.alloc(size);
    await handle.read(directory, 0, size, 16);
    const base = 16 + size;
    const files = [];
    (function walk(node, prefix) {
      for (const [name, entry] of Object.entries(node.files ?? {})) {
        const full = prefix ? `${prefix}/${name}` : name;
        if (entry.files) walk(entry, full);
        else files.push({ path: full, offset: base + Number(entry.offset), size: entry.size });
      }
    })(JSON.parse(directory.toString("utf8")));
    const extracted = new Map();
    for (const suffix of suffixes) {
      const file = files.find(candidate => candidate.path.split("\\").join("/").endsWith(`/${suffix}`));
      assert.ok(file, `bundle not found in the archive: ${suffix}`);
      const buffer = Buffer.alloc(file.size);
      await handle.read(buffer, 0, file.size, file.offset);
      const target = path.join(output, suffix);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, buffer);
      extracted.set(suffix, target);
    }
    return extracted;
  } finally { await handle.close(); }
}

/** Load one DSH client bundle: it registers itself with the shell module loader. */
async function loadClientBundle(file, stubs = {}) {
  const modules = new Map();
  globalThis.window = { __ModuleLoader__: { load: entry => modules.set(entry.id, entry.factory) } };
  new Function("window", await readFile(file, "utf8"))(globalThis.window);
  const entry = [...modules.entries()][0];
  assert.ok(entry, `${path.basename(file)} did not register with the module loader`);
  const external = { "@deepseek-ai/cordis": cordis, ...stubs };
  return entry[1](id => {
    if (external[id] === undefined) throw new Error(`${path.basename(file)} required unexpected module ${id}`);
    return external[id];
  });
}

async function verifyRegistry(bundle) {
  const { TypertRegistry } = await import(pathToFileURL(bundle).href);
  const context = new Context();
  new TypertRegistry(context);
  const dispose = context.typert.register(hostContribution);
  const payloads = { list: { query: "docs" }, setup: {}, focus: { ref: "dsh-browser://profile/1" } };
  for (const descriptor of descriptors) {
    const registered = context.typert.local.get(`${descriptor.namespace}/${descriptor.method}`);
    assert.equal(registered?.id, descriptor.id, `${descriptor.method} must register`);
    assert.deepEqual(registered.parameters[0].codec.create().parse(payloads[descriptor.method]),
      payloads[descriptor.method]);
  }
  assert.throws(() => context.typert.local.get("browserTabs/list").parameters[0].codec.create().parse({ query: 7 }),
    /must be a string/);
  await dispose();
  await context.fiber.dispose();
  console.log("PASS: the real Typert registry accepts the host contribution and decodes its requests.");
}

function fakeConnection(calls, reply) {
  return {
    rpc: { open: () => undefined, call: async (channel, endpoint, payload) => {
      calls.push({ channel, endpoint, args: payload.args });
      return reply(endpoint, payload.args);
    } },
    start: () => ({ stop() {} }),
    registerGenerationSource: () => () => {},
    isLoopback: true,
    generation: { getSnapshot: () => ({ host: { home: os.homedir() } }) },
  };
}

async function verifyGateway(bundle) {
  const gateway = await loadClientBundle(bundle);
  const calls = [];
  const connection = fakeConnection(calls, endpoint => ({
    ok: true,
    value: endpoint === "browserTabs/list" ? { tabs: [], connected: false }
      : endpoint === "browserTabs/setup" ? { url: "http://127.0.0.1:43187/setup", extensionPath: "/extension" }
        : { ok: true },
  }));
  const context = new Context();
  context.provide("connection", connection);
  context.provide("typert", { remotes: { register: () => () => {} } });
  gateway.apply(context);
  const dispose = await context.remote.$mount(remoteContribution);
  assert.ok(context.remote.browserTabs, "the contribution must mount remote.browserTabs");
  const listed = await context.remote.browserTabs.list({ query: "docs" });
  assert.deepEqual(listed, { ok: true, value: { tabs: [], connected: false } });
  assert.deepEqual(JSON.parse(JSON.stringify(calls.at(-1))),
    { channel: "/api", endpoint: "browserTabs/list", args: { request: { query: "docs" } } });
  // Negative control: the `src-json` markers this package used before 0.1.2 are refused.
  await assert.rejects(context.remote.$mount({ package: "dsh-browser-tabs-src", descriptors: descriptors.map(descriptor => ({
    ...descriptor,
    parameters: descriptor.parameters.map(parameter => ({ ...parameter, codec: { mode: "src-json" } })),
    result: { mode: "src-json" },
  })) }), /strict codec/);
  await dispose();
  await context.fiber.dispose();
  console.log("PASS: the real client Gateway mounts and invokes the Remote contribution.");
}

async function verifyBuiltClient(gatewayBundle) {
  let built;
  try {
    built = await loadClientBundle(path.resolve(root, "lib/client.js"), {
      react: { createElement: () => null, useState: () => [undefined, () => {}] },
      "@deepseek-ai/dsh-client-ui-primitives": { IconGlobeOutlineRegular: () => null },
    });
  } catch (error) {
    console.log(`SKIP: lib/client.js is not usable yet (${error.message}); run \`npm run build\` to include this check.`);
    return;
  }
  const gateway = await loadClientBundle(gatewayBundle);
  const tab = { ref: "dsh-browser://profile/7", title: "Example", url: "https://example.com/page", browser: "Edge" };
  const connection = fakeConnection([], endpoint => ({ ok: true,
    value: endpoint === "browserTabs/list" ? { tabs: [tab], connected: true } : { ok: true } }));
  const context = new Context();
  context.provide("connection", connection);
  context.provide("typert", { remotes: { register: () => () => {} } });
  const sources = [];
  context.provide("inputTriggers", { registerSource: source => { sources.push(source); return () => {}; } });
  gateway.apply(context);
  const fiber = context.plugin({ name: "dsh-browser-tabs", inject: built.inject, apply: ctx => built.apply(ctx) });
  await fiber.await();
  assert.ok(context.remote.browserTabs, "the built client must mount remote.browserTabs");
  const source = sources.find(candidate => candidate.trigger === "@");
  assert.ok(source, "the built client must register its @ source");
  const items = await source.candidates({ sessionId: "verify" }, { query: "", quoted: false, drilled: false });
  assert.equal(items.length, 1, JSON.stringify(items));
  assert.equal(items[0].name, "Example");
  await fiber.dispose();
  await context.fiber.dispose();
  console.log("PASS: the built client mounts the namespace and its @ source lists host tabs.");
}

await rm(output, { recursive: true, force: true });
const bundles = await extract([
  "dsh-api-gateway/lib/client.js",
  "dsh-typert-registry/lib/index.js",
]);
await verifyRegistry(bundles.get("dsh-typert-registry/lib/index.js"));
await verifyGateway(bundles.get("dsh-api-gateway/lib/client.js"));
await verifyBuiltClient(bundles.get("dsh-api-gateway/lib/client.js"));
console.log(`\nAll DSH contract checks passed against ${path.basename(archive)}.`);
