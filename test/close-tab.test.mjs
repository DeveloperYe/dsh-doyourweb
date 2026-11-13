import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { BrowserBridge } from "../src/bridge.js";
import { Grants } from "../src/grants.js";

function fakeProfile(id = "runtime", tabIds = [7]) {
  const tabs = new Map(tabIds.map(tabId => [tabId, { id: tabId, ref: `dsh-browser://${id}/${tabId}`,
    title: `Tab ${tabId}`, url: `https://example.test/${tabId}`, browser: "test" }]));
  return { id, ws: { readyState: 1 }, tabs, browser: "test" };
}

async function withBridge(run) {
  const root = await mkdtemp(path.join(os.tmpdir(), "dsh-close-tab-"));
  const bridge = new BrowserBridge({ home: path.join(root, "bridge"), port: 0 });
  try { await run(bridge); }
  finally { await bridge.close().catch(() => {}); await rm(root, { recursive: true, force: true }); }
}

test("browser_close asks the extension to close exactly that tab", async () => {
  await withBridge(async bridge => {
    const profile = fakeProfile();
    bridge.profiles.set("runtime", profile);
    const calls = [];
    bridge.request = async (target, method, params) => {
      calls.push({ target, method, params });
      setTimeout(() => profile.tabs.delete(7), 30);
      return { tabId: 7, closed: true };
    };
    const closed = await bridge.closeTab("dsh-browser://runtime/7");
    assert.equal(closed.closed, true);
    assert.equal(closed.title, "Tab 7");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, "dsh.closeTab");
    assert.deepEqual(calls[0].params[0], { tabId: 7 }, "the target tab id is what the extension acts on");
    assert.equal(profile.tabs.has(7), false, "the inventory drops the closed tab");
  });
});

test("browser_close is idempotent for a tab that is already gone", async () => {
  await withBridge(async bridge => {
    const profile = fakeProfile("runtime", []);
    bridge.profiles.set("runtime", profile);
    let sent = 0;
    bridge.request = async () => { sent++; return { tabId: 7, closed: true }; };
    const closed = await bridge.closeTab("dsh-browser://runtime/7");
    assert.equal(closed.closed, true);
    assert.equal(closed.title, "", "an unknown tab has no cached metadata");
    assert.equal(sent, 1, "the extension still gets the request; it decides what already-closed means");
  });
});

test("browser_close refuses a disconnected or unknown browser without sending", async () => {
  await withBridge(async bridge => {
    let sent = 0;
    bridge.request = async () => { sent++; return {}; };
    await assert.rejects(() => bridge.closeTab("dsh-browser://runtime/7"), /offline|session ended/);
    // The error has to tell the caller what to do next: an agent reading it cannot ask the user
    // on its own behalf, so the alternative (open a fresh tab) belongs in the message.
    await assert.rejects(() => bridge.closeTab("dsh-browser://runtime/7"), /browser_open/);
    await assert.rejects(() => bridge.closeTab("dsh-browser://runtime/7"), (error) => {
      assert.match(error.message, /select the tab with @ again/, "and the manual alternative stays visible");
      return true;
    });
    const profile = fakeProfile();
    profile.ws.readyState = 3;
    bridge.profiles.set("runtime", profile);
    await assert.rejects(() => bridge.closeTab("dsh-browser://runtime/7"), /disconnected/);
    assert.equal(sent, 0);
  });
});

test("browser_close rejects a malformed reference", async () => {
  await withBridge(async bridge => {
    bridge.profiles.set("runtime", fakeProfile());
    await assert.rejects(() => bridge.closeTab("https://example.test/"), /Invalid browser tab reference/);
  });
});

test("revoking a grant removes only the closed reference and persists", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "dsh-grants-revoke-"));
  const file = path.join(root, "authorized.json");
  try {
    const grants = new Grants({ file });
    await grants.allow("session", ["dsh-browser://runtime/7", "dsh-browser://runtime/8"]);
    assert.equal(grants.get("session").size, 2);
    assert.equal(await grants.revoke("session", ["dsh-browser://runtime/7"]), true);
    assert.deepEqual([...grants.get("session")], ["dsh-browser://runtime/8"]);
    await grants.save();
    const stored = JSON.parse(await readFile(file, "utf8"));
    assert.deepEqual(stored.sessions.session, ["dsh-browser://runtime/8"], "the closed tab is gone from disk too");
    assert.equal(await grants.revoke("session", ["dsh-browser://runtime/7"]), false, "revoking twice is a no-op");
    assert.equal(await grants.revoke("missing-session", ["dsh-browser://runtime/8"]), false);
    await grants.revoke("session", ["dsh-browser://runtime/8"]);
    assert.equal(grants.get("session").size, 0, "an empty set never authorizes anything");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
