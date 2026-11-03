import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { BrowserBridge } from "../src/bridge.js";

const tempRoot = () => mkdtemp(path.join(os.tmpdir(), "dsh-open-tab-"));

/** A connected browser as the bridge tracks it, without a real socket. */
function fakeProfile(id = "runtime") {
  return { id, ws: { readyState: 1 }, tabs: new Map([1, 2, 3].map(tabId => [tabId, null])).constructor === Map
    ? new Map() : new Map(), browser: "test" };
}

async function withBridge(run) {
  const root = await tempRoot();
  const bridge = new BrowserBridge({ home: path.join(root, "bridge"), port: 0 });
  try { await run(bridge); }
  finally { await bridge.close().catch(() => {}); await rm(root, { recursive: true, force: true }); }
}

test("browser_open refuses anything that is not an absolute http(s) URL", async () => {
  await withBridge(async bridge => {
    await assert.rejects(() => bridge.openTab(undefined, "file:///C:/secret.txt"), /http\(s\)/);
    await assert.rejects(() => bridge.openTab(undefined, "chrome://settings"), /http\(s\)/);
    await assert.rejects(() => bridge.openTab(undefined, "javascript:alert(1)"), /http\(s\)/);
    await assert.rejects(() => bridge.openTab(undefined, "not a url"), /absolute http\(s\)/);
    await assert.rejects(() => bridge.openTab(undefined, ""), /absolute http\(s\)/);
  });
});

test("browser_open needs a connected browser", async () => {
  await withBridge(async bridge => {
    await assert.rejects(() => bridge.openTab(undefined, "https://example.com/"), /No browser is connected/);
  });
});

test("browser_open needs a tab reference when several browsers are connected", async () => {
  await withBridge(async bridge => {
    bridge.profiles.set("a", fakeProfile("a"));
    bridge.profiles.set("b", fakeProfile("b"));
    await assert.rejects(() => bridge.openTab(undefined, "https://example.com/"), /Several browsers are connected/);
  });
});

test("browser_open asks the extension for one tab and returns the published reference", async () => {
  await withBridge(async bridge => {
    const profile = fakeProfile("runtime");
    bridge.profiles.set("runtime", profile);
    const calls = [];
    bridge.request = async (target, method, params) => {
      calls.push({ target, method, params });
      // The extension publishes tabs asynchronously, so answer before the row exists.
      setTimeout(() => profile.tabs.set(42, { id: 42, ref: "dsh-browser://runtime/42",
        title: "Opened", url: params[1].url, browser: "test" }), 40);
      return { tabId: 42 };
    };
    const opened = await bridge.openTab(undefined, "https://example.com/page");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, "dsh.openTab");
    assert.deepEqual(calls[0].params[1], { url: "https://example.com/page", active: false });
    assert.equal(calls[0].target, profile, "the request goes to the only connected browser");
    assert.equal(opened.ref, "dsh-browser://runtime/42");
    assert.equal(opened.tab.title, "Opened");
  });
});

test("browser_open forwards the focus flag and accepts an anchor tab reference", async () => {
  await withBridge(async bridge => {
    const profile = fakeProfile("runtime");
    profile.tabs.set(7, { id: 7, ref: "dsh-browser://runtime/7", title: "Fixture", url: "https://fixture.test/", browser: "test" });
    bridge.profiles.set("runtime", profile);
    const calls = [];
    bridge.request = async (target, method, params) => {
      calls.push({ method, params });
      setTimeout(() => profile.tabs.set(43, { id: 43, ref: "dsh-browser://runtime/43",
        title: "Second", url: params[1].url, browser: "test" }), 20);
      return { tabId: 43 };
    };
    const opened = await bridge.openTab("dsh-browser://runtime/7", "https://second.example/", { active: true });
    assert.equal(opened.ref, "dsh-browser://runtime/43");
    assert.equal(calls[0].params[1].active, true);
  });
});

test("browser_open reports a tab the extension never publishes", async () => {
  await withBridge(async bridge => {
    bridge.profiles.set("runtime", fakeProfile("runtime"));
    bridge.request = async () => ({ tabId: 99 });
    await assert.rejects(() => bridge.openTab(undefined, "https://example.com/", { timeoutMs: 300 }),
      /did not publish it in time/);
  });
});

test("browser_open rejects an extension reply without a tab id", async () => {
  await withBridge(async bridge => {
    bridge.profiles.set("runtime", fakeProfile("runtime"));
    bridge.request = async () => ({});
    await assert.rejects(() => bridge.openTab(undefined, "https://example.com/"), /did not report the new tab/);
  });
});

test("browser_open refuses a disconnected extension before sending anything", async () => {
  await withBridge(async bridge => {
    const profile = fakeProfile("runtime");
    profile.ws.readyState = 3;
    bridge.profiles.set("runtime", profile);
    let sent = 0;
    bridge.request = async () => { sent++; return { tabId: 1 }; };
    await assert.rejects(() => bridge.openTab(undefined, "https://example.com/"), /disconnected/);
    assert.equal(sent, 0);
  });
});
