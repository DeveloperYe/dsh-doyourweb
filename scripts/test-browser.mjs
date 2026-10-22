import { chromium } from "playwright-core";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { BrowserBridge } from "../src/bridge.js";
import { BrowserEngine } from "../src/engine.js";
import { WebMCP } from "../src/webmcp.js";
import { serialize } from "../src/output.js";
import { parseRef } from "../src/protocol.js";
import { Annotations } from "../src/annotations.js";

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
      `--explicitly-allowed-ports=${server.address().port}`,
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
    const ordinary = await webmcp.read(tab.ref);
    assert.ok(ordinary.snapshot, "automatic discovery must fall back to a real DOM snapshot on ordinary pages");
    let snapshots = 0;
    const snapshot = engine.snapshot.bind(engine);
    engine.snapshot = (...args) => { snapshots++; return snapshot(...args); };
    const webPage = await browser.newPage();
    await webPage.goto(`${fixtureUrl}/webmcp`);
    await webPage.evaluate(() => window.webmcpReady);
    const webTab = await waitForTab(`${fixtureUrl}/webmcp`);
    const catalog = await webmcp.read(webTab.ref, { limit: 8000 });
    assert.equal(catalog.tab, webTab.ref);
    assert.equal(snapshots, 0, "automatic discovery must not collect ARIA when WebMCP tools are available");
    const cached = await webmcp.list(webTab.ref, { limit: 8000 });
    assert.equal(cached.catalog, catalog.catalog, "unchanged discovery reuses its catalog");
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
    const chained = await webmcp.call(webTab.ref, { catalog: added.nextCatalog, name: "add_to_counter", arguments: { value: 2 } });
    assert.equal(chained.status, "completed", JSON.stringify(chained));
    assert.equal(JSON.parse(chained.result).count, 5);
    assert.equal(snapshots, 0, "successful WebMCP calls must not collect DOM snapshots either");
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
    assert.equal(await webPage.locator("#counter").textContent(), "5", "cancelled and blocked calls must not change the counter");
    const stale = await webmcp.list(webTab.ref, { query: "read_counter" });
    await webPage.reload();
    await assert.rejects(webmcp.call(webTab.ref, { catalog: stale.catalog, name: "read_counter", arguments: {} }), /stale/i);
    await webPage.close();
    engine.snapshot = snapshot;
    console.log("PASS: native WebMCP-first routing without DOM snapshots, ordinary-page fallback, cached discovery, chained single-use tokens, schema validation, iframe exclusion, cancellation, bounded output and stale tools/navigation through the real extension/CDP bridge.");
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
  const annotationMessages = [];
  const annotations = new Annotations(bridge, { submit: async request => { annotationMessages.push(request); return { accepted: true }; } });
  bridge.idleTimeoutMs = 30000;
  bridge.beforeRelease = ref => annotations.detach(ref);
  // CDP can inspect closed roots for tests; ordinary page scripts cannot access them.
  async function annotationControl(selector, evaluate, value) {
    const entry = annotations.pages.get(afterRestart.ref);
    const { root } = await entry.cdp.send("DOM.getDocument", { depth: -1, pierce: true });
    const findToolbar = node => node.attributes?.includes("data-dsh-annotation") ? node
      : [...(node.children || []), ...(node.shadowRoots || [])].map(findToolbar).find(Boolean);
    const host = findToolbar(root); assert.equal(host.shadowRoots[0].shadowRootType, "closed");
    const { nodeId } = await entry.cdp.send("DOM.querySelector", { nodeId: host.shadowRoots[0].nodeId, selector });
    assert.ok(nodeId, `annotation control ${selector} exists`);
    const context = [...entry.contexts.values()].find(item => item.name === entry.world && item.auxData?.frameId === entry.frameId);
    const { object } = await entry.cdp.send("DOM.resolveNode", { nodeId, executionContextId: context.id });
    try {
      const result = await entry.cdp.send("Runtime.callFunctionOn", { objectId: object.objectId,
        functionDeclaration: `function(value) { return (${evaluate.toString()})(this, value); }`,
        arguments: value === undefined ? [] : [{ value }], returnByValue: true, awaitPromise: true });
      assert.equal(result.exceptionDetails, undefined); return result.result.value;
    } finally { await entry.cdp.send("Runtime.releaseObject", { objectId: object.objectId }); }
  }
  async function clickAnnotation(selector) {
    const point = await annotationControl(selector, element => { const box = element.getBoundingClientRect(); return { x: box.x + box.width / 2, y: box.y + box.height / 2 }; });
    await reopened.mouse.click(point.x, point.y);
  }
  const fillAnnotation = text => annotationControl("textarea", (element, value) => { element.value = value; }, text);
  const waitAnnotation = text => annotationControl("output", (element, value) => {
    if (element.textContent.includes(value)) return;
    return new Promise(resolve => { const observer = new MutationObserver(() => { if (element.textContent.includes(value)) { observer.disconnect(); resolve(); } }); observer.observe(element, { childList: true, subtree: true, characterData: true }); });
  }, text);
  annotations.currentSession({ client: "browser-test", revision: 1, sessionId: "frontend-session", title: "Frontend test", active: true });
  await annotations.start(afterRestart.ref);
  const toolbar = reopened.locator('[data-dsh-annotation="toolbar"]');
  await reopened.evaluate(() => {
    window.pointerEffects = 0;
    document.querySelector("#save").addEventListener("pointerdown", () => window.pointerEffects++);
  });
  await reopened.locator("#save").click();
  assert.equal(await reopened.evaluate(() => window.pointerEffects), 0, "element selection must intercept pointerdown as well as click");
  assert.equal(await reopened.locator("#out").textContent(), "", "selection must not activate the underlying button");
  assert.equal(await reopened.evaluate(() => document.querySelector('[data-dsh-annotation="toolbar"]').shadowRoot), null, "page scripts cannot rewrite the private annotation controls");
  await fillAnnotation("Make this button green");
  await annotationControl('input[type="checkbox"]', element => { element.checked = true; });
  await annotationControl("button.primary", button => button.click());
  assert.equal(annotationMessages.length, 0, "a synthetic website click must not submit a user message");
  assert.equal(await reopened.evaluate(() => Object.keys(window).some(key => key.startsWith("__dshAnnotate_"))), false, "page scripts cannot see the isolated sending channel");
  await clickAnnotation("button.primary");
  await waitAnnotation("已加入");
  const [message] = annotationMessages;
  assert.equal(message.sessionId, "frontend-session"); assert.equal(message.mode, "draft");
  assert.match(message.content[0].text, /#save/); assert.match(message.content[0].text, /Make this button green/);
  assert.ok(Buffer.from(message.content[1].data, "base64").length > 50);
  const beforeDrag = await toolbar.boundingBox();
  const grip = await annotationControl("strong", element => { const box = element.getBoundingClientRect(); return { x: box.x + 10, y: box.y + 5 }; });
  await reopened.mouse.move(grip.x, grip.y); await reopened.mouse.down();
  await reopened.mouse.move(grip.x - 200, grip.y + 100, { steps: 5 }); await reopened.mouse.up();
  const afterDrag = await toolbar.boundingBox();
  assert.ok(afterDrag.x < beforeDrag.x - 100 && afterDrag.y > beforeDrag.y + 50, "toolbar should follow drag gestures");
  await annotations.start(afterRestart.ref);
  await reopened.locator("h1").click(); await fillAnnotation("Second annotation");
  await clickAnnotation("textarea"); await reopened.keyboard.press("Enter");
  await waitAnnotation("已加入");
  assert.equal(annotationMessages.length, 2);
  assert.match(annotationMessages[1].content[0].text, /Second annotation/);
  assert.equal(annotationMessages[1].mode, "draft");
  await reopened.reload();
  await toolbar.waitFor();
  assert.equal(await reopened.frameLocator("iframe").locator('[data-dsh-annotation="toolbar"]').count(), 0, "toolbar must not be injected into child frames");
  const artifactDir = process.env.DSH_TEST_ARTIFACTS;
  if (artifactDir) await mkdir(artifactDir, { recursive: true });
  for (const width of [1280, 375]) {
    await reopened.setViewportSize({ width, height: 800 });
    const box = await toolbar.boundingBox(); assert.ok(box.x >= 0 && box.x + box.width <= width, "annotation controls must fit mobile and desktop");
    if (artifactDir) await reopened.screenshot({ path: path.join(artifactDir, `annotation-${width}.png`) });
  }
  bridge.management = async ({ action }) => action === "apps" ? { apps: [{ name: "Unity", title: "Test project", ref: "fixture" }] }
    : { applications: { plans: [], connectors: [], connections: [], policy: { askBeforeInstall: true, trustedPublishers: [] } } };
  const manager = await browser.newPage();
  const errors = []; manager.on("pageerror", error => errors.push(error.message));
  await manager.goto(`http://127.0.0.1:${bridge.port}/manage`);
  await manager.locator("#status").filter({ hasText: "本机连接已就绪" }).waitFor();
  await manager.getByRole("tab", { name: "应用程序" }).click();
  await manager.getByRole("cell", { name: "Unity", exact: true }).waitFor();
  assert.equal(await manager.getByRole("tab", { name: "批注", exact: true }).count(), 0, "there is no independent annotation library");
  for (const width of [1280, 375]) {
    await manager.setViewportSize({ width, height: 800 });
    assert.equal(await manager.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, "management page must not overflow horizontally");
    if (artifactDir) await manager.screenshot({ path: path.join(artifactDir, `management-${width}.png`), fullPage: true });
  }
  assert.deepEqual(errors, []); await manager.close(); await annotations.detach(afterRestart.ref);
  assert.equal(await toolbar.count(), 0, "annotation close must remove the toolbar");
  await annotations.start(afterRestart.ref);
  await reopened.locator("#save").click();
  await fillAnnotation("Unfinished draft");
  bridge.idleTimeoutMs = 500;
  bridge.release(afterRestart.ref);
  await toolbar.waitFor({ state: "detached" });
  bridge.idleTimeoutMs = 30000;
  await annotations.start(afterRestart.ref);
  await reopened.locator("#save").click();
  assert.equal(await annotationControl("textarea", element => element.value), "Unfinished draft", "idle detach keeps a draft in the original page only");
  annotations.currentSession({ client: "browser-test", revision: 2, sessionId: "another-session", title: "Another conversation", active: true });
  await annotations.start(afterRestart.ref);
  await reopened.locator("#save").click();
  await fillAnnotation("Second annotation");
  await clickAnnotation("button.primary");
  await waitAnnotation("Another conversation");
  assert.equal(annotationMessages.at(-1).sessionId, "another-session");
  await annotations.close();
  console.log("PASS: isolated element picker, trusted-click-only direct conversation messages, cropped image attachments without annotation files, session switching, draft recovery and responsive management UI.");
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
