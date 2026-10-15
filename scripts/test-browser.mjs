import { chromium } from "playwright-core";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { BrowserBridge } from "../src/bridge.js";
import { BrowserEngine } from "../src/engine.js";
import { WebMCP } from "../src/webmcp.js";
import { serialize } from "../src/output.js";
import { parseRef } from "../src/protocol.js";

const home = await mkdtemp(path.join(os.tmpdir(), "dsh-browser-test-"));
const favicon = await readFile(new URL("../extension/icons/icon-16.png", import.meta.url));
const webmcpFixture = await readFile(new URL("../test/fixtures/webmcp.html", import.meta.url), "utf8");
const server = createServer((req, response) => {
  if (req.url === "/favicon.png") {
    response.setHeader("Content-Type", "image/png");
    response.end(favicon);
    return;
  }
  if (req.url === "/webmcp") {
    response.setHeader("Content-Type", "text/html; charset=utf-8");
    response.end(webmcpFixture);
    return;
  }
  if (req.url === "/webmcp-frame") {
    response.setHeader("Content-Type", "text/html");
    response.end('<script>document.modelContext.registerTool({name:"child_only",description:"Excluded child tool",execute:()=>"child"});</script>');
    return;
  }
  response.setHeader("Content-Type", "text/html");
  response.end(req.url === "/frame" ? '<button onclick="this.textContent=\'Frame clicked\'">Frame button</button>' : `<!doctype html><html><title>DSH Browser Test</title><link rel="icon" href="/favicon.png"><h1>Browser test</h1><label>Name <input id="name"></label><label><input type="checkbox" id="enabled">Enabled</label><button id="save">Save</button><output id="out"></output><iframe src="/frame"></iframe><script>document.querySelector('#save').onclick=()=>document.querySelector('#out').textContent='Saved '+document.querySelector('#name').value;</script></html>`);
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const fixtureUrl = `http://127.0.0.1:${server.address().port}`;
const bridge = new BrowserBridge({ home: path.join(home, "bridge"), port: 43188, idleTimeoutMs: 500 });
let browser;
async function launchBrowser() {
  return chromium.launchPersistentContext(path.join(home, "profile"), {
    headless: true, channel: "chromium",
    args: ["--enable-experimental-web-platform-features",
      `--disable-extensions-except=${bridge.extensionPath}`, `--load-extension=${bridge.extensionPath}`],
  });
}

/** Point the extension at this test's bridge port through its popup, as a user would. */
async function configurePort(port) {
  const popup = await browser.newPage();
  try {
    await popup.goto(`chrome-extension://${bridge.id}/popup.html`);
    await popup.fill("#port", String(port));
    await popup.click("#save-port");
    await popup.waitForFunction(value => document.querySelector("#port")?.value === String(value), port);
  } finally { await popup.close(); }
}

/** Approve the extension's pairing request, as the user does on the setup page. */
async function waitForPairing() {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const [request] = bridge.pairings.list();
    if (request) {
      assert.equal(bridge.approvePairing(request.id), true);
      return request;
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.fail("The extension must ask to pair when it has no token yet");
}

async function waitForTab(url = `${fixtureUrl}/`) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const tab = bridge.list().find(tab => tab.url === url && tab.favicon);
    if (tab) return tab;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  console.error("Test inventory:", bridge.list());
  const worker = browser.serviceWorkers()[0];
  if (worker) console.error("Test favicon diagnostic:", await worker.evaluate(async () => {
    const tabs = await chrome.tabs.query({});
    const tab = tabs.find(tab => tab.url?.startsWith("http://127.0.0.1:"));
    if (!tab) return { error: "No local fixture tab" };
    const url = new URL(chrome.runtime.getURL("_favicon/"));
    url.searchParams.set("pageUrl", tab.url);
    url.searchParams.set("size", "16");
    try {
      const response = await fetch(url);
      return { status: response.status, type: response.headers.get("content-type"),
        bytes: (await response.arrayBuffer()).byteLength, cachedIcon: !!tab.favIconUrl };
    } catch (error) { return { error: error.message, cachedIcon: !!tab.favIconUrl }; }
  }));
  assert.fail("Extension should connect and publish existing tabs with local cached icons");
}

try {
  await bridge.start();
  await bridge.close();
  browser = await launchBrowser();
  browser.on("weberror", error => console.error("Browser error:", error.error().message));
  browser.on("console", message => { if (message.type() === "error") console.error("Browser console:", message.text()); });
  const page = await browser.newPage();
  await page.goto(fixtureUrl);
  await configurePort(43188);
  await bridge.start();
  const pairing = await waitForPairing();
  assert.match(pairing.code, /^[0-9]{4}$/);
  const tab = await waitForTab();
  assert.match(tab.favicon, /^data:image\/png;base64,/);
  const image = Buffer.from(tab.favicon.split(",")[1], "base64");
  assert.equal(image.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
  assert.equal(image.readUInt32BE(16), 16);
  assert.equal(image.readUInt32BE(20), 16);
  const engine = new BrowserEngine(bridge, { artifactDir: path.join(home, "captures") });
  const initial = await engine.read(tab.ref);
  const nameRef = initial.content.match(/textbox "Name" \[ref=(e\d+)\]/)?.[1];
  const saveRef = initial.content.match(/button "Save" \[ref=(e\d+)\]/)?.[1];
  assert.ok(nameRef && saveRef, initial.content);
  const result = await engine.act(tab.ref, { snapshot: initial.snapshot, observe: "summary", steps: [
    { op: "fill", ref: nameRef, value: "DSH" }, { op: "click", ref: saveRef },
    { op: "wait", selector: "#out", state: "visible", timeout: 2000 },
    { op: "extract", selector: "#out", fields: ["text"] },
  ] });
  assert.equal(result.completed.length, 4, JSON.stringify(result));
  assert.equal(result.results[0].rows[0].text, "Saved DSH");
  assert.equal(result.snapshot, undefined, "summary must not collect another full snapshot");
  assert.equal(await page.locator("#out").textContent(), "Saved DSH");
  const frames = await engine.read(tab.ref);
  const frameRef = frames.content.match(/button "Frame button" \[ref=(f\d+e\d+)\]/)?.[1];
  assert.ok(frameRef, frames.content);
  const frameResult = await engine.act(tab.ref, { snapshot: frames.snapshot, observe: "summary",
    steps: [{ op: "click", ref: frameRef }] });
  assert.equal(frameResult.completed.length, 1, JSON.stringify(frameResult));
  assert.equal(await page.frameLocator("iframe").getByRole("button").textContent(), "Frame clicked");
  const beforeReload = await engine.read(tab.ref);
  await page.reload();
  await assert.rejects(engine.act(tab.ref, { snapshot: beforeReload.snapshot, steps: [{ op: "click", selector: "#save" }] }), /stale/);
  const beforeCancel = await engine.read(tab.ref);
  const controller = new AbortController();
  const cancelTimer = setTimeout(() => controller.abort(), 250);
  const interrupted = await engine.act(tab.ref, { snapshot: beforeCancel.snapshot, steps: [
    { op: "click", selector: "#missing" }, { op: "click", selector: "#save" },
  ] }, controller.signal).finally(() => clearTimeout(cancelTimer));
  assert.equal(interrupted.cancelled, true, JSON.stringify(interrupted));
  assert.equal(interrupted.completed.length, 0);
  assert.equal(interrupted.uncertainStep, 0);
  const recovered = await engine.read(tab.ref);
  assert.equal(recovered.lastAction.cancelled, true);
  const capture = await engine.capture(tab.ref);
  assert.ok(capture.path.endsWith(".png"));
  const webmcp = new WebMCP(engine);
  try {
    const empty = await webmcp.list(tab.ref);
    assert.equal(empty.supported, true);
    assert.deepEqual(empty.tools, [], "ordinary pages keep using DOM automation");
    const webPage = await browser.newPage();
    await webPage.goto(`${fixtureUrl}/webmcp`);
    await webPage.evaluate(() => window.webmcpReady);
    const webTab = await waitForTab(`${fixtureUrl}/webmcp`);
    const catalog = await webmcp.list(webTab.ref, { limit: 8000 });
    assert.ok(catalog.tools.some(tool => tool.name === "read_counter"));
    assert.equal(catalog.tools.some(tool => tool.name === "child_only"), false, "iframe tools stay outside this experiment");
    assert.ok(serialize(catalog).length <= 8000);
    const increment = await webmcp.list(webTab.ref, { query: "add_to_counter" });
    await assert.rejects(webmcp.call(webTab.ref, { catalog: increment.catalog, name: "add_to_counter",
      arguments: { value: "bad" } }), /arguments/i);
    assert.equal(await webPage.locator("#counter").textContent(), "0", "invalid arguments must never reach the callback");
    const added = await webmcp.call(webTab.ref, { catalog: increment.catalog, name: "add_to_counter", arguments: { value: 3 } });
    assert.equal(added.status, "completed", JSON.stringify(added));
    assert.equal(JSON.parse(added.result).count, 3);
    assert.equal(await webPage.locator("#counter").textContent(), "3");
    await assert.rejects(webmcp.call(webTab.ref, { catalog: increment.catalog, name: "add_to_counter", arguments: { value: 3 } }), /catalog/i);
    const slow = await webmcp.list(webTab.ref, { query: "slow_counter" });
    const timedOut = await webmcp.call(webTab.ref, { catalog: slow.catalog, name: "slow_counter", arguments: { value: 100 }, timeout: 40 });
    assert.equal(timedOut.status, "timeout", JSON.stringify(timedOut));
    assert.equal(timedOut.mayHaveLateEffects, true);
    const blocked = await webmcp.list(webTab.ref, { query: "consequential_action" });
    await assert.rejects(webmcp.call(webTab.ref, { catalog: blocked.catalog, name: "consequential_action", arguments: {} }), /consequential/i);
    const large = await webmcp.list(webTab.ref, { query: "large_result" });
    const bounded = await webmcp.call(webTab.ref, { catalog: large.catalog, name: "large_result", arguments: {}, limit: 400 });
    assert.equal(bounded.truncated, true);
    assert.ok(serialize(bounded).length <= 400);
    const changed = await webmcp.list(webTab.ref, { query: "read_counter" });
    await webPage.evaluate(() => new Promise(resolve => {
      document.modelContext.addEventListener("toolchange", resolve, { once: true });
      document.modelContext.registerTool({ name: "new_tool", description: "Invalidate the old catalog", execute: () => "new" });
    }));
    await assert.rejects(webmcp.call(webTab.ref, { catalog: changed.catalog, name: "read_counter", arguments: {} }), /changed/i);
    assert.equal(await webPage.locator("#counter").textContent(), "3", "cancelled and blocked calls must not change the counter");
    const stale = await webmcp.list(webTab.ref, { query: "read_counter" });
    await webPage.reload();
    await assert.rejects(webmcp.call(webTab.ref, { catalog: stale.catalog, name: "read_counter", arguments: {} }), /stale/i);
    await webPage.close();
    console.log("PASS: native document.modelContext registration/discovery/calls through the real extension/CDP bridge, schema validation, single-use catalogs, iframe exclusion, cancellation, bounded output and stale tools/navigation.");
  } finally { await webmcp.close(); }
  for (let index = 0; index < 100 && bridge.relays.size; index++) await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(bridge.relays.size, 0, "idle connections release the debugger");
  assert.equal(engine.states.has(tab.ref), false, "idle snapshots are released too");
  assert.equal(page.isClosed(), false);
  await engine.read(tab.ref);
  assert.equal(bridge.relays.size, 1, "another read safely reconnects after detach");
  await bridge.close();
  await page.locator("#name").fill("Still open");
  assert.equal(await page.locator("#name").inputValue(), "Still open");
  await bridge.start();
  assert.deepEqual(bridge.pairings.list(), [], "an already paired extension must not ask to pair again");
  const reconnected = await waitForTab();
  assert.equal(reconnected.ref, tab.ref, "DSH restart must preserve references to still-open tabs");
  await engine.read(reconnected.ref);
  assert.equal(await page.locator("#name").inputValue(), "Still open");
  await browser.close();
  browser = await launchBrowser();
  const reopened = await browser.newPage();
  await reopened.goto(fixtureUrl);
  const afterRestart = await waitForTab();
  assert.notEqual(parseRef(afterRestart.ref).profile, parseRef(tab.ref).profile,
    "browser restart rotates tab identity even if numeric IDs are reused");
  assert.throws(() => bridge.resolve(tab.ref), /offline|session/i);
  await engine.read(afterRestart.ref);
  engine.close();
  console.log("PASS: code pairing, cached tab icons, background reconnect, browser-lifetime authorization, authenticated CDP, batched fill/click/wait/extract, summary output, iframe refs through the engine, stale navigation, in-flight cancellation, screenshot, idle detach and reattach without closing the tab.");
} finally {
  await bridge.close();
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
  // Only the fresh disposable directory returned by mkdtemp is removed.
  assert.equal(path.dirname(path.resolve(home)), path.resolve(os.tmpdir()));
  assert.ok(path.basename(home).startsWith("dsh-browser-test-"));
  await rm(home, { recursive: true, force: true });
}
