import { chromium } from "playwright-core";
import { readFile } from "node:fs/promises";

const svg = await readFile(new URL("../extension/icons/globe.svg", import.meta.url), "utf8");
const browser = await chromium.launch({ headless: true, channel: "chromium" });
try {
  const page = await browser.newPage();
  for (const size of [16, 32, 48, 128]) {
    await page.setViewportSize({ width: size, height: size });
    await page.setContent(`<style>html,body{margin:0;width:100%;height:100%;color:#237841}svg{display:block;width:100%;height:100%}</style>${svg}`);
    await page.screenshot({ path: `extension/icons/icon-${size}.png`, omitBackground: true });
  }
} finally { await browser.close(); }
console.log("Generated companion extension icons from Lucide globe artwork.");
