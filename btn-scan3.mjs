import { chromium } from "playwright-core";
const base = "http://bg1.idckvm.top:3080";
const ctx = await chromium.launch({ executablePath: process.env.CHROME_EXE, headless: true, args: ["--no-sandbox","--disable-gpu"] });
const page = await (await ctx.newContext()).newPage();
await page.goto(base + "/-/auth/login", { waitUntil: "domcontentloaded" });
await page.fill("#gate-password", "Haolin@31");
await page.press("#gate-password", "Enter");
await page.waitForFunction(() => document.body && (document.body.innerText||"").length > 200, { timeout: 40000 });
await page.waitForTimeout(2500);
const res = await page.evaluate(() => {
  const inputs = [...document.querySelectorAll("textarea,[contenteditable=true],[contenteditable=''],input[type=text]")].map(e => ({ tag: e.tagName, cls: (e.className+"").slice(0,50), ph: e.getAttribute("placeholder") }));
  const attachBtns = [...document.querySelectorAll("button,[role=button]")].map((b,i) => ({ i, a: b.getAttribute("aria-label"), t: b.getAttribute("title") })).filter(b => b.a && /附件|文件|上传|attach|file|upload|clip|image|图片/i.test(b.a));
  return { inputs: inputs.slice(0,5), attachBtns };
});
console.log(JSON.stringify(res, null, 1));
await ctx.close();
