#!/usr/bin/env node
/**
 * Regenerate `docs/setup-page.png`, the screenshot the READMEs embed. It renders
 * the real setup page (with a synthetic pending pairing request) against the
 * documented default port, so the image cannot disagree with the docs.
 *
 * Usage: node scripts/generate-setup-screenshot.mjs
 */
import { chromium } from "playwright-core";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { BrowserBridge } from "../src/bridge.js";

const home = await mkdtemp(path.join(os.tmpdir(), "dsh-setup-shot-"));
const bridge = new BrowserBridge({ home: path.join(home, "bridge"), port: 0 });
await bridge.start();
// A stand-in for the extension's pairing socket: it only has to fill the list.
bridge.acceptPairing({ readyState: 1, send: () => {}, close: () => {}, on: () => {} });
// The page only prints this value; the listener itself stays on the ephemeral port.
bridge.port = 43187;
const file = path.join(home, "setup.html");
await writeFile(file, bridge.setupPage("c2V0dXAtcGFnZS1zaG90"));

const browser = await chromium.launch({ headless: true, channel: "chromium" });
try {
  const view = await browser.newPage({ viewport: { width: 900, height: 700 }, deviceScaleFactor: 2 });
  await view.goto(new URL(`file://${file}`).href);
  await view.waitForTimeout(200);
  await view.screenshot({ path: path.resolve("docs/setup-page.png"), fullPage: true });
} finally {
  await browser.close();
  await bridge.close();
  await rm(home, { recursive: true, force: true });
}
console.log("Wrote docs/setup-page.png (port 43187).");
