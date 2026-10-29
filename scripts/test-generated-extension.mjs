// End-to-end proof of the generated extension: start a bridge with default
// settings, load the folder it produced into a real Chromium, and check the
// browser appears without any pairing step.
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import { chromium } from "playwright-core";
import { BrowserBridge } from "../src/bridge.js";

const home = await mkdtemp(path.join(os.tmpdir(), "dsh-generated-"));
const server = createServer((request, response) => {
  response.setHeader("Content-Type", "text/html");
  response.end("<!doctype html><title>Generated extension fixture</title><h1>hello</h1>");
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const fixtureUrl = `http://127.0.0.1:${server.address().port}/`;

const bridge = new BrowserBridge({ home: path.join(home, "bridge"), port: 43190 });
let browser;
try {
  await bridge.start();
  const [build] = bridge.extensionBuilds;
  assert.ok(build, "the bridge must generate an extension for loopback");
  const config = await readFile(path.join(build.dir, "config.js"), "utf8");
  assert.ok(config.includes(bridge.settings.token), "the generated config carries the token");
  console.log(`generated: ${path.basename(build.dir)}  endpoint=${build.endpoint}  bytes=${build.bytes}`);

  browser = await chromium.launchPersistentContext(path.join(home, "profile"), {
    headless: true, channel: "chromium",
    args: [`--disable-extensions-except=${build.dir}`, `--load-extension=${build.dir}`],
  });
  browser.on("console", message => { if (message.type() === "error") console.error("browser:", message.text()); });
  const page = await browser.newPage();
  await page.goto(fixtureUrl);

  const deadline = Date.now() + 20000;
  let tab;
  while (Date.now() < deadline && !tab) {
    tab = bridge.list().find(entry => entry.url === fixtureUrl);
    if (!tab) await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(tab, `the generated extension must connect on its own; inventory=${JSON.stringify(bridge.list())}`);
  assert.equal(bridge.pairings.list().length, 0, "loading the generated folder must not need pairing");
  assert.ok(bridge.profiles.size >= 1);
  console.log(`connected without pairing: ${tab.title} -> ${tab.url}`);
  console.log(`extension id in use: ${[...bridge.profiles.values()][0].sourceId}`);
  console.log("PASS: a generated extension loads, connects with its built-in token, and publishes tabs");
} finally {
  await browser?.close().catch(() => {});
  await bridge.close();
  server.close();
  await rm(home, { recursive: true, force: true });
}
