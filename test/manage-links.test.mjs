import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { decorateExtensions } from "../src/host.js";
import { BrowserBridge } from "../src/bridge.js";

test("generated-extension download links stay origin-relative", () => {
  const builds = [
    { key: "wss-36.138.189.24-39066", label: "36.138.189.24", endpoint: "wss://36.138.189.24:39066/extension", bytes: 30000 },
    { key: "ws-127.0.0.1-43287", label: "本机", bytes: 29000 },
  ];
  const decorated = decorateExtensions({ extensionBuilds: builds, port: 43287 });
  assert.equal(decorated.length, 2);
  for (const build of decorated) {
    // A relative href resolves against whatever origin the page was opened on, so one page
    // serves both the loopback operator and the published wss origin.
    assert.match(build.download, /^\/extension\.zip\?p=[\w.-]+$/);
    assert.equal(build.download.includes("://"), false, "an absolute URL breaks one of the two origins");
    assert.equal(build.download.startsWith("http"), false, "the scheme must come from the page, not the payload");
  }
  assert.equal(decorated[0].download, "/extension.zip?p=wss-36.138.189.24-39066");
  assert.equal(decorateExtensions({}).length, 0);
});

test("the setup page links downloads relatively instead of pinning loopback", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "dsh-manage-links-"));
  const bridge = new BrowserBridge({ home: path.join(root, "bridge"), port: 0 });
  try {
    await bridge.start();
    const html = await (await fetch(bridge.setupUrl())).text();
    assert.match(html, /href="\/extension\.zip\?p=/, "the page must link the zip relatively");
    assert.equal(html.includes(`127.0.0.1:${bridge.port}/extension.zip`), false,
      "an absolute loopback zip link breaks the published origin");
    assert.equal(html.includes(bridge.manageSecret), false, "the page body never repeats the secret");
  } finally {
    await bridge.close();
    await rm(root, { recursive: true, force: true });
  }
});
