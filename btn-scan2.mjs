import { chromium } from "playwright-core";
const base = "http://bg1.idckvm.top:3080";
const ctx = await chromium.launch({ executablePath: process.env.CHROME_EXE, headless: true, args: ["--no-sandbox","--disable-gpu"] });
const page = await (await ctx.newContext()).newPage();
await page.goto(base + "/-/auth/login", { waitUntil: "domcontentloaded" });
await page.fill("#gate-password", "Haolin@31");
await page.press("#gate-password", "Enter");
await page.waitForFunction(() => document.querySelectorAll("textarea,input").length > 0, { timeout: 40000 });
await page.waitForTimeout(1500);
// 找到 composer 容器（textarea 的祖先 form 或最近容器），列出其内部按钮
const res = await page.evaluate(() => {
  const ta = document.querySelector("textarea");
  if (!ta) return "no textarea";
  let root = ta.closest("form") || ta.parentElement?.parentElement?.parentElement || ta.parentElement;
  const btns = [...root.querySelectorAll("button,[role=button]")].map(b => ({ a: b.getAttribute("aria-label"), t: b.getAttribute("title"), txt: (b.textContent||"").trim().slice(0,24) }));
  return { tag: root.tagName + "." + (root.className+"").slice(0,50), btns };
});
console.log(JSON.stringify(res, null, 1).slice(0, 1800));
await ctx.close();
