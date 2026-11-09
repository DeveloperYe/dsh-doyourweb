import { chromium } from "playwright-core";
const base = "http://172.16.0.59:3080";
const ctx = await chromium.launch({ executablePath: process.env.CHROME_EXE, headless: true, args: ["--no-sandbox","--disable-gpu"] });
const page = await (await ctx.newContext()).newPage();
await page.goto(base + "/-/auth/login", { waitUntil: "domcontentloaded", timeout: 20000 }).catch(() => console.log("内网无 gate（401 直达 DSH）——用 token 路径"));
await page.waitForTimeout(1500);
if (!(await page.$('[aria-label="添加文件或调用指令"]'))) {
  const tok = (await import("fs")).readFileSync("D:/Users/Administrator/Documents/deepseek-harness/work/dsh-token.txt", "utf8").trim();
  await page.goto(tok, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2500);
}
await page.waitForSelector('[aria-label="添加文件或调用指令"]', { timeout: 40000 }).catch(() => {});
await page.waitForTimeout(1200);
await page.click('[aria-label="添加文件或调用指令"]');
await page.waitForTimeout(900);
await page.evaluate(() => { const items = [...document.querySelectorAll('[role=menuitem],[role=menu] button,[class*=menu] button,[class*=Menu] button')]; const f = items.find(b => /文件file/.test((b.textContent||""))); if (f) f.click(); });
await page.waitForTimeout(2500);
const state = await page.evaluate(() => ({ dialog: [...document.querySelectorAll('[role=dialog]')].length, treeLike: [...document.querySelectorAll('[class*=tree],[class*=Tree],[class*=browse],[class*=Browse]')].length, fileInputs: document.querySelectorAll('input[type=file]').length }));
console.log("内网(172.16.0.59) 点文件后:", JSON.stringify(state));
await ctx.close();


