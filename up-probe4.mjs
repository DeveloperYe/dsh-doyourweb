import { chromium } from "playwright-core";
const base = "http://bg1.idckvm.top:3080";
const ctx = await chromium.launch({ executablePath: process.env.CHROME_EXE, headless: true, args: ["--no-sandbox","--disable-gpu"] });
const page = await (await ctx.newContext()).newPage();
const net = [];
page.on("response", (r) => { if (/upload|attach/i.test(r.url())) net.push(`${r.status()} ${r.request().method()} ${r.url().slice(base.length, base.length+70)}`); });
page.on("console", (m) => { if (m.type() === "error" && !/denia|directory|403/.test(m.text())) net.push("CONSOLE: " + m.text().slice(0, 140)); });
await page.goto(base + "/-/auth/login", { waitUntil: "domcontentloaded" });
await page.fill("#gate-password", "Haolin@31");
await page.press("#gate-password", "Enter");
await page.waitForSelector('[aria-label="添加文件或调用指令"]', { timeout: 40000 }).catch(() => {});
await page.waitForTimeout(1200);
await page.click('[aria-label="添加文件或调用指令"]');
await page.waitForTimeout(800);
const fileItem = page.locator('[role=menuitem]', { hasText: /文件|file/i }).first();
const [chooser] = await Promise.all([
  page.waitForEvent("filechooser", { timeout: 10000 }),
  fileItem.click(),
]);
await chooser.setFiles("D:/dsh/plugins/dsh-doyourweb-remote/up-test.png");
console.log("文件已选定");
await page.waitForTimeout(5000);
const chipInfo = await page.evaluate(() => { const t = document.body.innerText || ""; return { mentions: (t.match(/up-test/g) || []).length }; });
console.log(`UI 中 up-test 提及: ${chipInfo.mentions}`);
console.log("上传网络:"); net.filter(n => !n.startsWith("CONSOLE")).slice(0,6).forEach(n => console.log("  " + n));
console.log("相关 console 错误:"); net.filter(n => n.startsWith("CONSOLE")).slice(0,6).forEach(n => console.log("  " + n));
// 发送带附件的消息走完整链路
await page.keyboard.type("附件测试");
await page.keyboard.press("Enter");
await page.waitForTimeout(6000);
const after = net.filter(n => /upload/i.test(n));
console.log(`发送后上传请求总数: ${after.length}`);
await ctx.close();
