import { chromium } from "playwright-core";
const base = "http://bg1.idckvm.top:3080";
const ctx = await chromium.launch({ executablePath: process.env.CHROME_EXE, headless: true, args: ["--no-sandbox","--disable-gpu"] });
const page = await (await ctx.newContext()).newPage();
const net = [];
page.on("response", (r) => { if (/upload|attach/i.test(r.url()) || r.status() >= 400) net.push(`${r.status()} ${r.url().slice(base.length, base.length+70)}`); });
page.on("console", (m) => { if (m.type() === "error") net.push("CONSOLE: " + m.text().slice(0, 120)); });
await page.goto(base + "/-/auth/login", { waitUntil: "domcontentloaded" });
await page.fill("#gate-password", "Haolin@31");
await page.press("#gate-password", "Enter");
await page.waitForFunction(() => document.body && (document.body.innerText||"").includes("添加文件或调用指令") === false ? document.querySelector('[aria-label="添加文件或调用指令"]') : false, { timeout: 40000 }).catch(() => {});
await page.waitForTimeout(1500);
const [chooser] = await Promise.all([
  page.waitForEvent("filechooser", { timeout: 10000 }),
  page.click('[aria-label="添加文件或调用指令"]'),
]);
await chooser.setFiles("D:/dsh/plugins/dsh-doyourweb-remote/up-test.png");
console.log("文件已选定，等待上传网络活动...");
await page.waitForTimeout(5000);
// 看 UI 上有没有出现附件 chip
const chip = await page.evaluate(() => { const t = document.body.innerText || ""; return { hasChip: /up-test|png/i.test(t), text: t.slice(0, 0) }; });
console.log(`chip 出现: ${chip.hasChip}`);
console.log("上传相关网络活动:"); net.filter(n => /upload|attach/i.test(n)).slice(0,8).forEach(n => console.log("  " + n));
console.log(`错误类网络: ${net.filter(n => !/upload|attach/.test(n)).length}`); net.filter(n => !/upload|attach/.test(n)).slice(0,5).forEach(n => console.log("  " + n));
await ctx.close();
