import { randomUUID } from "node:crypto";
import path from "node:path";
import { mkdir } from "node:fs/promises";
import { canControl } from "./protocol.js";

export function pageChunk(snapshot, offset = 0, limit = 2400) {
  if (!Number.isInteger(offset) || offset < 0 || offset > snapshot.text.length) throw new Error("Invalid snapshot cursor");
  const end = Math.min(snapshot.text.length, offset + limit);
  const newline = snapshot.text.lastIndexOf("\n", end);
  const boundary = end < snapshot.text.length && newline > offset ? newline + 1 : end;
  return {
    snapshot: snapshot.id, url: snapshot.url, title: snapshot.title,
    content: snapshot.text.slice(offset, boundary),
    ...(boundary < snapshot.text.length ? { cursor: `${snapshot.id}:${boundary}`, omittedChars: snapshot.text.length - boundary } : {}),
  };
}

function checkpoint(signal) { signal?.throwIfAborted(); }

export class BrowserEngine {
  constructor(bridge, { snapshotChars = 2400, artifactDir } = {}) {
    this.bridge = bridge;
    this.snapshotChars = snapshotChars;
    this.artifactDir = artifactDir;
    this.states = new Map();
    this.queues = new Map();
  }

  async serial(ref, operation) {
    const previous = this.queues.get(ref) || Promise.resolve();
    const current = previous.catch(() => {}).then(operation);
    this.queues.set(ref, current);
    try { return await current; }
    finally { if (this.queues.get(ref) === current) this.queues.delete(ref); }
  }

  async document(page) {
    return page.evaluate(() => ({ url: location.href, epoch: performance.timeOrigin }));
  }

  async snapshot(ref, page, options = {}) {
    const before = await this.document(page);
    if (!canControl(before.url)) throw new Error("This tab navigated to an unsupported URL");
    let root = page.locator("body");
    if (options.selector) root = page.locator(options.selector);
    if (options.query) root = root.getByText(options.query, { exact: false });
    const text = await root.ariaSnapshot({ mode: "ai", depth: options.depth || 8, timeout: 8000 });
    const after = await this.document(page);
    if (before.epoch !== after.epoch || before.url !== after.url) throw new Error("Page navigated while reading; read it again");
    const state = { id: randomUUID().slice(0, 8), text, ...after, title: await page.title(), ref };
    this.states.set(ref, state);
    return state;
  }

  async read(ref, options = {}, signal) {
    return this.serial(ref, async () => {
      checkpoint(signal);
      const page = await this.bridge.page(ref);
      const limit = Math.max(400, Math.min(8000, options.limit || this.snapshotChars));
      if (options.cursor) {
        const [id, offset] = options.cursor.split(":");
        const state = this.states.get(ref);
        const document = await this.document(page);
        if (!state || state.id !== id || document.epoch !== state.epoch || document.url !== state.url) {
          throw new Error("Snapshot cursor is stale; read the page again without cursor");
        }
        checkpoint(signal);
        return { tab: ref, ...pageChunk(state, Number(offset), limit) };
      }
      const state = await this.snapshot(ref, page, options);
      checkpoint(signal);
      return { tab: ref, ...pageChunk(state, 0, limit) };
    });
  }

  locator(page, step) {
    if (step.ref) {
      if (!/^e\d+$/.test(step.ref)) throw new Error("Use an element ref from the latest browser_read snapshot");
      return page.locator(`aria-ref=${step.ref}`);
    }
    if (step.selector) return page.locator(step.selector);
    throw new Error("Action requires ref or selector");
  }

  async act(ref, options, signal) {
    return this.serial(ref, async () => {
      checkpoint(signal);
      const page = await this.bridge.page(ref);
      const state = this.states.get(ref);
      const document = await this.document(page);
      if (!state || options.snapshot !== state.id || document.epoch !== state.epoch || document.url !== state.url) {
        throw new Error("Snapshot is stale. Call browser_read before acting; no actions were performed.");
      }
      const completed = [];
      let failure;
      let navigated = false;
      for (let index = 0; index < options.steps.length; index++) {
        checkpoint(signal);
        const step = options.steps[index];
        try {
          if (step.op === "navigate") {
            if (!canControl(step.value)) throw new Error("Only HTTP/HTTPS navigation is supported");
            await page.goto(step.value, { waitUntil: "domcontentloaded" });
          } else if (step.op === "back") await page.goBack({ waitUntil: "domcontentloaded" });
          else if (step.op === "forward") await page.goForward({ waitUntil: "domcontentloaded" });
          else if (step.op === "scroll") {
            await page.mouse.wheel(0, step.amount || 600);
          } else {
            const target = this.locator(page, step);
            if (step.op === "click") await target.click();
            else if (step.op === "fill") await target.fill(step.value);
            else if (step.op === "press") await target.press(step.value);
            else if (step.op === "select") await target.selectOption(step.value);
            else if (step.op === "check") await target.setChecked(step.checked ?? true);
            else if (step.op === "hover") await target.hover();
            else throw new Error(`Unknown action: ${step.op}`);
          }
          completed.push({ index, op: step.op });
          const after = await this.document(page);
          if (after.epoch !== document.epoch || after.url !== document.url) { navigated = true; break; }
        } catch (error) { failure = { index, op: step.op, error: error.message }; break; }
      }
      // After any attempted mutation, old refs are invalid even if the action failed.
      this.states.delete(ref);
      const result = { tab: ref, completed, remaining: options.steps.length - completed.length,
        ...(failure ? { failure, retry: "Read current state first. Do not repeat completed actions." } : {}),
        ...(navigated ? { navigated: true, stopped: "Navigation occurred; read the new page before remaining actions." } : {}) };
      checkpoint(signal);
      try {
        const next = await this.snapshot(ref, page);
        return { ...result, ...pageChunk(next, 0, Math.min(this.snapshotChars, 1600)) };
      } catch (error) { return { ...result, url: page.url(), readError: error.message }; }
    });
  }

  async capture(ref, options = {}, signal) {
    return this.serial(ref, async () => {
      checkpoint(signal);
      const page = await this.bridge.page(ref);
      await mkdir(this.artifactDir, { recursive: true });
      const output = path.join(this.artifactDir, `browser-${randomUUID()}.png`);
      await page.screenshot({ path: output, fullPage: options.fullPage === true, animations: "disabled" });
      checkpoint(signal);
      return { tab: ref, url: page.url(), path: output, mediaType: "image/png" };
    });
  }
}
