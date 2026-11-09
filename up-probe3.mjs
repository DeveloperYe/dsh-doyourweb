import { chromium } from "playwright-core";
const base = "http://bg1.idckvm.top:3080";
const ctx = await chromium.launch({ executablePath: process.env.CHROME_EXE, headless: true, args: ["--no-sandbox","--disable-gpu"] });
const page = await (await ctx.newContext()).newPage();
await page.goto(base + "/-/auth/login", { waitUntil: "domcontentloaded" });
await page.fill("#gate-password", "Haolin@31");
await page.press("#gate-password", "Enter");
await page.waitForSelector('[aria-label="添加文件或调用指令"]', { timeout: 40000 }).catch(() => {});
await page.waitForTimeout(1200);
await page.click('[aria-label="添加文件或调用指令"]');
await page.waitForTimeout(1200);
const menu = await page.evaluate(() => {
  const items = [...document.querySelectorAll('[role=menuitem],[role=menu] button,[role=dialog] button,[class*=menu] button,[class*=Menu] button,[class*=popover] button,[class*=Popover] button')];
  return items.map(b => ({ txt: (b.textContent||"").trim().slice(0,30), a: b.getAttribute("aria-label") })).filter(x => x.txt || x.a).slice(0, 15);
});
console.log(JSON.stringify(menu, null, 1));
await ctx.close();
