import { test } from "node:test";
import assert from "node:assert/strict";
import { apply, inject } from "../src/client.js";
import { descriptors } from "../src/protocol.js";

/**
 * The client half runs inside the DSH UI (web and desktop share the same bundle),
 * so "does the plugin show up in the UI" means: does applying it register the `@`
 * and `/` sources, and do their candidates carry `dsh-browser://` references?
 */
function fakeCtx(service) {
  const sources = [];
  const mounted = [];
  const effects = [];
  const ctx = {
    effect(factory) { const dispose = factory(); effects.push(dispose); return dispose; },
    get: key => (key === "remote.browserTabs" ? service : undefined),
    inputTriggers: { registerSource: source => { sources.push(source); return () => {}; } },
    remote: { $mount: contribution => { mounted.push(contribution); return () => {}; } },
  };
  return { ctx, sources, mounted, effects };
}

function service({ tabs = [], connected = true, apps = [], error } = {}) {
  return {
    list: async () => (error ? { ok: false, error: { message: error } } : { ok: true, value: { connected, tabs } }),
    apps: async () => ({ ok: true, value: { apps } }),
    setup: async () => ({ ok: true, value: { url: "http://127.0.0.1:43187/setup?k=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" } }),
    manage: async () => ({ ok: true, value: { url: "http://127.0.0.1:43187/manage?k=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" } }),
    focus: async () => ({ ok: true, value: { ok: true } }),
    annotationSession: async () => ({ ok: true, value: { ok: true, drafts: [] } }),
  };
}

const icon = () => ({ name: "browser" });

test("the client half mounts its Remote contribution and every menu source", () => {
  const { ctx, sources, mounted } = fakeCtx(service());
  apply(ctx, { browserIcon: icon, tabIcon: icon, appIcon: icon });
  assert.equal(mounted.length, 1, "the Host-for-Client contribution must be mounted");
  assert.deepEqual(mounted[0].descriptors.map(item => item.method).sort(), descriptors.map(item => item.method).sort());
  assert.deepEqual(sources.map(source => `${source.trigger}:${source.name}`).sort(),
    ["/:browser-setup", "/:doyourweb-manage", "@:browser-tabs", "@:desktop-apps"]);
  for (const source of sources) {
    assert.equal(typeof source.candidates, "function", `${source.name} must answer candidates`);
    assert.equal(typeof source.onPick, "function", `${source.name} must handle a pick`);
  }
  assert.deepEqual(inject.sort(), ["inputTriggers", "remote"]);
});

test("the @ source lists tabs as dsh-browser references the composer can insert", async () => {
  const { ctx, sources } = fakeCtx(service({ tabs: [
    { ref: "dsh-browser://runtime/7", title: "Docs", url: "https://example.com/docs", browser: "Edge" },
    { ref: "dsh-browser://runtime/8", title: "Local", url: "file:///C:/x.html", browser: "Edge" },
  ] }));
  apply(ctx, { browserIcon: icon, tabIcon: icon });
  const source = sources.find(item => item.name === "browser-tabs");
  const candidates = await source.candidates({}, { query: "", quoted: false, drilled: false });
  assert.equal(candidates.length, 2);
  assert.match(candidates[0].description, /example\.com/, "the description names the host");
  assert.match(candidates[1].description, /本地 HTML/, "a file tab is labelled as local HTML");
  const { insert } = source.onPick({ candidate: candidates[0] });
  assert.equal(insert.source, "browser-tabs");
  // The composer receives a reference chip: @[title](ref), with the bare ref as its
  // clipboard text, so the user message carries the identity the bridge authorises on.
  assert.equal(insert.ref, "@[Docs](dsh-browser://runtime/7)");
  assert.equal(insert.clipboardText, "@[Docs](dsh-browser://runtime/7)");
  assert.equal(insert.appearance, "file");
});

test("the menus degrade instead of throwing when the service is unavailable", async () => {
  const offline = fakeCtx(service({ error: "browser service is not registered by the DSH host" }));
  apply(offline.ctx, { browserIcon: icon, tabIcon: icon });
  const tabs = await offline.sources.find(item => item.name === "browser-tabs")
    .candidates({}, { query: "", quoted: false, drilled: false });
  assert.equal(tabs.length, 1);
  assert.equal(tabs[0].value, "setup", "an offline browser falls back to the setup entry");
  assert.match(tabs[0].description, /不可用/);

  const empty = fakeCtx(service({ tabs: [], connected: false }));
  apply(empty.ctx, { browserIcon: icon, tabIcon: icon });
  const pending = await empty.sources.find(item => item.name === "browser-tabs")
    .candidates({}, { query: "", quoted: false, drilled: false });
  assert.equal(pending[0].value, "setup");
  assert.match(pending[0].description, /未连接/);
});

test("picking the setup entry opens the gated URL the host handed back", async () => {
  const opened = [];
  const original = globalThis.window;
  globalThis.window = { open: url => opened.push(url) };
  try {
    const { ctx, sources } = fakeCtx(service());
    apply(ctx, { browserIcon: icon, tabIcon: icon, appIcon: icon });
    const slash = sources.find(item => item.name === "browser-setup");
    const candidates = await slash.candidates({}, { query: "", quoted: false, drilled: false });
    const setup = candidates.find(item => item.value === "setup");
    assert.ok(setup, `the / menu must offer the setup entry: ${JSON.stringify(candidates)}`);
    const result = slash.onPick({ candidate: setup });
    assert.deepEqual(result, { text: "" }, "picking must not insert text into the composer");
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(opened.length, 1);
    assert.match(opened[0], /\/setup\?k=[0-9a-f]{64}$/);
  } finally {
    globalThis.window = original;
  }
});
