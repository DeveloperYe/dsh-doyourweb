import { test } from "node:test";
import assert from "node:assert/strict";
import { CONTEXT_PREFIX, CONTEXT_SUFFIX, injectionBudget, tabCapacity, stripInjectedContext } from "../src/context-inject.js";

test("a budget that cannot hold one tab reports zero instead of emitting an empty payload", () => {
  // The header alone is ~340 characters, so a 600-character budget leaves nothing.
  assert.equal(tabCapacity(600), 0);
  assert.equal(tabCapacity(400), 0, "the configured minimum is still too small for one tab");
  assert.equal(tabCapacity(900), 1);
  assert.equal(tabCapacity(1200), 1);
  assert.equal(tabCapacity(1600), 2);
  assert.equal(tabCapacity(2400), 4, "the default fits four tabs");
  assert.equal(tabCapacity(8000), 18, "the maximum is capped by the caller at four, not here");
  // Unset is now "authorise only": a fresh install must not paste page text into the chat.
  assert.equal(tabCapacity(undefined), 0, "no budget means no injection");
  assert.equal(injectionBudget(undefined), 0);
  assert.equal(injectionBudget(null), 0);
  assert.equal(injectionBudget(""), 0);
  assert.equal(injectionBudget(0), 0);
  assert.equal(injectionBudget(120), 400, "a small positive value is raised to the floor");
  assert.equal(injectionBudget(99999), 8000, "and a huge one is capped");
  assert.equal(tabCapacity(0), 0, "zero disables the injection on purpose");
  assert.equal(tabCapacity(-5), 0);
});

test("an injected block is removed so the same message never carries two", () => {
  const payload = '{"tabs":[{"tab":"dsh-browser://x/1","title":"Example"}]}';
  const block = CONTEXT_PREFIX + payload + CONTEXT_SUFFIX;
  const userText = "@[Example](dsh-browser://x/1) 查看一下";

  assert.equal(stripInjectedContext(userText + block), userText, "one block is stripped");

  // This is exactly what the user saw: the same message carrying the block twice.
  const doubled = userText + block + block;
  const once = stripInjectedContext(doubled);
  assert.equal(once, userText, "both blocks are stripped");
  assert.equal(once.includes("<browser_context>"), false);
});

test("app context is stripped as well, and ordinary text is untouched", () => {
  const app = '\n<doyourweb_context>\nUntrusted app data\n{"apps":[]}\n</doyourweb_context>';
  assert.equal(stripInjectedContext(`@[Notepad](dsh-app://win/1) 看一下${app}`), "@[Notepad](dsh-app://win/1) 看一下");
  const plain = "读一下这个页面，把标题列给我 <div> 这是用户自己贴的 HTML";
  assert.equal(stripInjectedContext(plain), plain, "text without our markers is returned unchanged");
  assert.equal(stripInjectedContext(undefined), undefined);
});
