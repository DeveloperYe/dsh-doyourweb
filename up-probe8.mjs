import { chromium } from "playwright-core";
import { writeFileSync } from "fs";
const base = "http://bg1.idckvm.top:3080";
writeFileSync("D:/dsh/plugins/dsh-doyourweb-remote/up-test.png", Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c626001000000ffff03000006000557bfabd40000000049454e44ae426082", "hex"));
const ctx = await chromium.launch({ executablePath: process.env.CHROME_EXE, headless: true, args: ["--no-sandbox","--disable-gpu"] });
const page = await (await ctx.newContext()).newPage();
const net = [];
page.on("response", (r) => { if (/upload/i.test(r.url())) net.push(`${r.status()} ${r.request().method()} ${r.url().slice(base.length, base.length+60)}`); });
await page.goto(base + "/-/auth/login", { waitUntil: "domcontentloaded" });
await page.fill("#gate-password", "Haolin@31");
await page.press("#gate-password", "Enter");
await page.waitForSelector('[aria-label="添加文件或调用指令"]', { timeout: 40000 }).catch(() => {});
await page.waitForTimeout(1500);
// 模拟拖拽：构造 DataTransfer drop 到 composer 区域
const dropRes = await page.evaluate(async () => {
  const dt = new DataTransfer();
  const resp = await fetch("data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==");
  const blob = await resp.blob();
  const file = new File([blob], "up-test.png", { type: "image/png" });
  dt.items.add(file);
  const target = document.querySelector('[class*="input"][class*="uV2eYG"]') || document.querySelector("[contenteditable=true]") || document.body;
  for (const type of ["dragenter", "dragover", "drop"]) {
    target.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt }));
  }
  return "dropped";
});
console.log(dropRes);
await page.waitForTimeout(5000);
console.log("拖拽后上传请求:"); net.slice(0,5).forEach(n => console.log("  " + n));
if (net.length === 0) {
  // 拖拽 UI 走粘贴通道
  await page.evaluate(async () => {
    const resp = await fetch("data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==");
    const blob = await resp.blob();
    const dt = new DataTransfer();
    dt.items.add(new File([blob], "up-test.png", { type: "image/png" }));
    const ev = new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: dt });
    document.dispatchEvent(ev);
  });
  await page.waitForTimeout(5000);
  console.log("粘贴后上传请求:"); net.slice(0,5).forEach(n => console.log("  " + n));
}
await ctx.close();
