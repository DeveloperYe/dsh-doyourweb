import { chromium } from "playwright-core";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { BrowserBridge } from "../src/bridge.js";
import { BrowserEngine } from "../src/engine.js";
import { parseRef } from "../src/protocol.js";

const home = await mkdtemp(path.join(os.tmpdir(), "dsh-browser-test-"));
const favicon = await readFile(new URL("../extension/icons/icon-16.png", import.meta.url));
const server = createServer((req, response) => {
  if (req.url === "/favicon.png") {
    response.setHeader("Content-Type", "image/png");
    response.end(favicon);
    return;
  }
  response.setHeader("Content-Type", "text/html");
  response.end(req.url === "/frame" ? '<button onclick="this.textContent=\'Frame clicked\'">Frame button</button>' : `<!doctype html><html><title>DSH Browser Test</title><link rel="icon" href="/favicon.png"><h1>Browser test</h1><label>Name <input id="name"></label><label><input type="checkbox" id="enabled">Enabled</label><button id="save">Save</button><output id="out"></output><iframe src="/frame"></iframe><script>document.querySelector('#save').onclick=()=>document.querySelector('#out').textContent='Saved '+document.querySelector('#name').value;</script></html>`);
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const fixtureUrl = `http://127.0.0.1:${server.address().port}`;
const bridge = new BrowserBridge({ home: path.join(home, "bridge"), port: 43188 });
let browser;
async function launchBrowser() {
  return chromium.launchPersistentContext(path.join(home, "profile"), {
    headless: true, channel: "chromium",
    args: [`--disable-extensions-except=${bridge.extensionPath}`, `--load-extension=${bridge.extensionPath}`],
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

async function waitForTab() {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const tab = bridge.list().find(tab => tab.url === `${fixtureUrl}/` && tab.favicon);
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
  const result = await engine.act(tab.ref, { snapshot: initial.snapshot, steps: [
    { op: "fill", ref: nameRef, value: "DSH" }, { op: "click", ref: saveRef },
  ] });
  assert.equal(result.completed.length, 2, JSON.stringify(result));
  assert.equal(await page.locator("#out").textContent(), "Saved DSH");
  const attachedPage = await bridge.page(tab.ref);
  await attachedPage.frameLocator("iframe").getByRole("button", { name: "Frame button" }).click();
  assert.equal(await page.frameLocator("iframe").getByRole("button").textContent(), "Frame clicked");
  await page.reload();
  await assert.rejects(engine.act(tab.ref, { snapshot: result.snapshot, steps: [{ op: "click", selector: "#save" }] }), /stale/);
  const capture = await engine.capture(tab.ref);
  assert.ok(capture.path.endsWith(".png"));
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
  assert.equal(parseRef(afterRestart.ref).profile, parseRef(tab.ref).profile);
  await engine.read(afterRestart.ref);
  console.log("PASS: one-time code pairing with the shipped extension folder, existing tab inventory and cached icons without popup, automatic reconnection after DSH/browser restarts, authenticated CDP, compact refs, batched fill/click, iframe, stale navigation, screenshot, release without closing existing tab.");
} finally {
  await bridge.close();
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
  // Only the fresh disposable directory returned by mkdtemp is removed.
  await rm(home, { recursive: true, force: true });
}
