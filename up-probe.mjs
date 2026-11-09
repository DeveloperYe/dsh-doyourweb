import { chromium } from "playwright-core";
import { writeFileSync } from "fs";
const base = "http://bg1.idckvm.top:3080";
writeFileSync("D:/dsh/plugins/dsh-doyourweb-remote/up-test.png", Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c626001000000ffff03000006000557bfabd40000000049454e44ae426082", "hex"));
const ctx = await chromium.launch({ executablePath: process.env.CHROME_EXE, headless: true, args: ["--no-sandbox","--disable-gpu"] });
const page = await (await ctx.newContext()).newPage();
const errors = [];
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text().slice(0, 150)); });
page.on("response", (r) => { if (r.url().includes("upload") || r.status() >= 400) errors.push(`HTTP ${r.status()} ${r.url().slice(base.length, base.length+80)}`); });
await page.goto(base + "/-/auth/login", { waitUntil: "domcontentloaded" });
await page.fill("#gate-password", "Haolin@31");
await page.press("#gate-password", "Enter");
await page.waitForFunction(() => document.querySelectorAll("textarea,input").length > 0, { timeout: 40000 });
await page.waitForTimeout(2000);
// 找输入区的附件按钮（回形针）并走 file chooser
const clip = page.locator('button:has([class*="clip"]), button:has([class*="attach"]), [aria-label*="附件"], [aria-label*="attach"], [title*="附件"], [title*="attach"]').first();
let used = false;
if (await clip.count() > 0) {
  const [chooser] = await Promise.all([
    page.waitForEvent("filechooser", { timeout: 8000 }).catch(() => null),
    clip.click().catch(() => {}),
  ]);
  if (chooser) { await chooser.setFiles("D:/dsh/plugins/dsh-doyourweb-remote/up-test.png"); used = true; console.log("已通过附件按钮上传"); }
}
if (!used) { console.log("回形针按钮未找到，直接监听网络观察拖拽通道"); }
await page.waitForTimeout(4000);
const chip = await page.evaluate(() => { const els = [...document.querySelectorAll("[class*='upload'],[class*='attachment'],[class*='chip'],img")]; return els.filter(e => (e.className + "").match(/upload|attach/i)).length; });
console.log(`上传 UI 元素: ${chip}, console错误 ${errors.length}:`); errors.slice(0, 8).forEach(e => console.log("  " + e));
await ctx.close();

