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
await page.waitForTimeout(1000);
// 宽选择器找「文件」菜单项
const clicked = await page.evaluate(() => {
  const items = [...document.querySelectorAll('[role=menuitem],[role=menu] button,[class*=menu] button,[class*=Menu] button')];
  const fileItem = items.find(b => (b.textContent||"").trim().startsWith("文件") || /文件file/.test((b.textContent||"")));
  if (fileItem) { const r = fileItem.getBoundingClientRect(); fileItem.click(); return { ok: true, txt: (fileItem.textContent||"").slice(0,30), x: r.x, y: r.y }; }
  return { ok: false, all: items.map(b => (b.textContent||"").trim().slice(0,15)).slice(0,12) };
});
console.log("click:", JSON.stringify(clicked).slice(0, 300));
await page.waitForTimeout(1800);
const ui = await page.evaluate(() => {
  const overlays = [...document.querySelectorAll('[role=dialog],[class*=dialog],[class*=Dialog],[class*=picker],[class*=Picker],[class*=browsetree],[class*=Tree],[class*=drawer]')];
  return overlays.map(e => ({ cls: (e.className+"").slice(0,50), txt: (e.textContent||"").trim().replace(/\s+/g," ").slice(0,100) })).filter(x => x.txt).slice(0, 8);
});
console.log("弹出层:", JSON.stringify(ui, null, 1).slice(0, 1500));
await ctx.close();
