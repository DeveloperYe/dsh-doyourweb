import { randomUUID } from "node:crypto";
import path from "node:path";
import { mkdir, stat, access, realpath } from "node:fs/promises";
import { constants } from "node:fs";
import { canControl } from "./protocol.js";
import { clip, serialize } from "./output.js";
import { browserActivity } from "./activity.js";
import { NetworkCapture } from "./network.js";
import { CAPTURE_KEEP, CAPTURE_MAX_AGE_DAYS, pruneDirectory } from "./retention.js";

export function pageChunk(snapshot, offset = 0, limit = 2400) {
  if (!Number.isInteger(offset) || offset < 0 || offset > snapshot.text.length) throw new Error("Invalid snapshot cursor");
  const end = Math.min(snapshot.text.length, offset + limit);
  const newline = snapshot.text.lastIndexOf("\n", end - 1);
  const boundary = end < snapshot.text.length && newline > offset ? newline + 1 : end;
  return {
    snapshot: snapshot.id, url: snapshot.url, title: snapshot.title,
    content: snapshot.text.slice(offset, boundary),
    ...(boundary < snapshot.text.length ? { cursor: `${snapshot.id}:${boundary}`, omittedChars: snapshot.text.length - boundary } : {}),
  };
}

function boundedChunk(state, offset, limit, extra) {
  const metadata = { ...state, title: clip(state.title, Math.min(128, Math.floor(limit / 10))),
    url: clip(state.url, Math.min(512, Math.floor(limit / 5))) };
  let truncated = metadata.title !== state.title || metadata.url !== state.url;
  const result = length => ({ ...extra, ...pageChunk(metadata, offset, length),
    ...(truncated ? { metadataTruncated: true } : {}) });
  const minimum = offset < state.text.length ? 1 : 0;
  // Reserve metadata and cursor first, then fit the JSON-escaped text. Raw
  // character limits alone miss long titles, URLs, quotes and context escaping.
  for (const field of ["title", "url"]) {
    if (serialize(result(minimum)).length <= limit) break;
    metadata[field] = undefined;
    truncated = true;
  }
  if (serialize(result(minimum)).length > limit) throw new Error("Output budget is too small for the action receipt; increase limit");
  let low = minimum, high = Math.min(state.text.length - offset, limit);
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (serialize(result(middle)).length <= limit) low = middle;
    else high = middle - 1;
  }
  return result(low);
}

function checkpoint(signal) { signal?.throwIfAborted(); }

function boundedExtraction(index, data, limit) {
  const result = { index, rows: data.rows, omittedRows: data.totalRows - data.rows.length,
    ...(data.truncated ? { truncated: true } : {}) };
  const dropRow = () => { result.rows.pop(); result.omittedRows++; };
  if (serialize(result).length <= limit) return result;
  result.truncated = true;
  while (result.rows.length > 1 && serialize(result).length > limit) dropRow();
  if (result.rows.length) {
    for (let size = 100; serialize(result).length > limit && size >= 4; size = Math.floor(size / 2)) {
      for (const key of Object.keys(result.rows[0])) result.rows[0][key] = clip(result.rows[0][key], size);
    }
    if (serialize(result).length > limit) dropRow();
  }
  return result;
}

function boundAction(result) {
  for (const [object, key] of [[result.failure, "error"], [result, "readError"], [result, "url"]]) {
    while (serialize(result).length > 1400 && object?.[key]?.length > 16) {
      object[key] = clip(object[key], Math.floor(object[key].length / 2));
      if (key === "url") result.metadataTruncated = true;
    }
  }
  while (serialize(result).length > 1400) {
    const entry = result.results?.filter(entry => entry.rows?.length)
      .sort((a, b) => serialize(b).length - serialize(a).length)[0];
    if (!entry) {
      const upload = result.results?.find(entry => entry.files?.length);
      if (!upload) break;
      upload.files.pop(); upload.omittedFiles = (upload.omittedFiles || 0) + 1;
      continue;
    }
    entry.rows.pop(); entry.omittedRows++; entry.truncated = true;
  }
  return result;
}

export class BrowserEngine {
  constructor(bridge, { readChars = 2400, artifactDir } = {}) {
    this.bridge = bridge;
    // Page size for browser_read, independent of the reference-injection budget: setting
    // snapshotChars to 0 used to shrink every read to the 400-character floor as well.
    this.readChars = readChars;
    this.snapshotChars = readChars;
    this.artifactDir = artifactDir;
    this.states = new Map();
    this.queues = new Map();
    this.receipts = new Map();
    this.networks = new Map();
    // Last viewport seen while capturing, per tab. Pointer coordinates are only meaningful
    // against the viewport they were measured in, and the browser chrome (a debugger infobar,
    // for instance) can change it between two actions.
    this.viewports = new Map();
    // Playwright keeps its own cursor position, but we need one to draw a human-looking path.
    this.pointerAt = new Map();
    this.onRelease = ref => { this.states.delete(ref); this.networks.get(ref)?.close(); this.networks.delete(ref);
      this.viewports.delete(ref); this.pointerAt.delete(ref); };
    this.bridge.on?.("release", this.onRelease);
  }

  close() {
    this.bridge.off?.("release", this.onRelease);
    this.states.clear();
    this.receipts.clear();
    for (const capture of this.networks.values()) capture.close();
    this.networks.clear();
  }

  async withPage(ref, operation, signal, active = false) {
    checkpoint(signal);
    const page = await this.bridge.page(ref);
    const controller = new AbortController();
    const actionSignal = active && this.bridge.cdp ? signal ? AbortSignal.any([signal, controller.signal]) : controller.signal : signal;
    let activity;
    try {
      if (active && this.bridge.cdp) activity = await browserActivity(this.bridge, ref, controller);
      return await operation(page, actionSignal, activity);
    } finally { await activity?.close(); this.bridge.release?.(ref); }
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

  async snapshot(ref, page, options = {}, signal) {
    checkpoint(signal);
    const before = await this.document(page);
    if (!canControl(before.url)) throw new Error("This tab navigated to an unsupported URL");
    let root = page.locator("body");
    if (options.scope === "main") {
      const main = page.locator("main, [role='main']");
      if (await main.count() === 1 && await main.isVisible()) root = main;
    }
    if (options.selector) root = page.locator(options.selector);
    if (options.query) root = root.getByText(options.query, { exact: false });
    const text = await root.ariaSnapshot({ mode: "ai", depth: options.depth || 8, timeout: 8000, signal });
    const after = await this.document(page);
    checkpoint(signal);
    if (before.epoch !== after.epoch || before.url !== after.url) throw new Error("Page navigated while reading; read it again");
    const state = { id: randomUUID().slice(0, 8), text, ...after, title: await page.title(), ref };
    this.states.set(ref, state);
    return state;
  }

  async read(ref, options = {}, signal) {
    return this.serial(ref, () => this.withPage(ref, async page => {
      checkpoint(signal);
      const limit = Math.max(400, Math.min(8000, options.limit || this.readChars));
      if (options.cursor) {
        const [id, offset] = options.cursor.split(":");
        const state = this.states.get(ref);
        const document = await this.document(page);
        if (!state || state.id !== id || document.epoch !== state.epoch || document.url !== state.url) {
          throw new Error("Snapshot cursor is stale; read the page again without cursor");
        }
        checkpoint(signal);
        const chunk = boundedChunk(state, Number(offset), limit, { tab: ref,
          ...(this.receipts.has(ref) ? { lastAction: this.receipts.get(ref) } : {}) });
        state.refsAvailable = true;
        return chunk;
      }
      const state = await this.snapshot(ref, page, options, signal);
      checkpoint(signal);
      return boundedChunk(state, 0, limit, { tab: ref,
        ...(this.receipts.has(ref) ? { lastAction: this.receipts.get(ref) } : {}) });
    }, signal));
  }

  /**
   * Measure the viewport once it stops moving. Browser chrome (the debugger infobar, a download
   * shelf, a permission bubble) is inserted asynchronously, so a single read can catch the layout
   * before or during the change.
   */
  async settleViewport(page, attempts = 6) {
    let previous;
    for (let attempt = 0; attempt < attempts; attempt++) {
      const current = await page.evaluate(() => ({
        width: window.innerWidth, height: window.innerHeight,
        devicePixelRatio: window.devicePixelRatio || 1,
        scrollX: Math.round(window.scrollX), scrollY: Math.round(window.scrollY),
      })).catch(() => undefined);
      if (!current) return undefined;
      if (previous && previous.width === current.width && previous.height === current.height
        && previous.devicePixelRatio === current.devicePixelRatio) return current;
      previous = current;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    return previous;
  }

  /** Current viewport, in the space pointer coordinates live in. */
  async measureViewport(page) {
    const measured = await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight,
      devicePixelRatio: window.devicePixelRatio || 1 })).catch(() => null);
    if (measured) return measured;
    const fallback = page.viewportSize?.() || { width: 0, height: 0 };
    return { ...fallback, devicePixelRatio: 1 };
  }

  /**
   * Coordinates are only valid against the viewport they were measured in. Browser chrome can
   * change that between two actions - attaching the debugger inserts an infobar, which shortens
   * the page by roughly the height of that bar - so a stale coordinate lands somewhere else
   * without any error. Refuse instead, and say what changed.
   */
  assertViewport(ref, current, action) {
    const seen = this.viewports.get(ref);
    if (!seen?.width || !current?.width) return;
    const moved = seen.width !== current.width || seen.height !== current.height
      || Math.abs((seen.devicePixelRatio || 1) - (current.devicePixelRatio || 1)) > 0.01;
    if (!moved) return;
    throw new Error(`Viewport changed since the screenshot (${seen.width}x${seen.height} at ${seen.devicePixelRatio}x `
      + `→ ${current.width}x${current.height} at ${current.devicePixelRatio}x), so a pixel coordinate no longer points at `
      + `the same place. Capture the tab again, or pass xRatio/yRatio so the point follows the viewport.`);
  }

  /**
   * Raw pointer input, for UIs that draw their controls instead of using elements: canvas
   * games, canvas maps, custom widgets. Coordinates are viewport CSS pixels with the origin at
   * the top-left of the visible area, which is the space browser_capture reports once its
   * device pixels are divided by the reported devicePixelRatio. xRatio/yRatio (0..1) do the same
   * job without pinning the value to the current viewport size.
   *
   * Clicks are dispatched the way a person produces them - glide to the point over several
   * intermediate positions, pause, press, hold briefly, release - because canvas UIs often react
   * to mousedown/mouseup separately and treat an instantaneous click as noise.
   */
  async pointer(page, step, signal, ref) {
    checkpoint(signal);
    const action = step.action || "click";
    const button = step.button || "left";
    const viewport = await this.measureViewport(page);
    this.assertViewport(ref, viewport, action);
    const clampRatio = value => Math.min(1, Math.max(0, value));
    const point = (value, ratio, axis) => {
      const size = axis === "x" ? viewport.width : viewport.height;
      if (ratio !== undefined) return Math.round(clampRatio(ratio) * size);
      if (value === undefined) return undefined;
      if (size && (value < 0 || value > size)) {
        throw new Error(`mouse coordinates are outside the ${viewport.width}x${viewport.height} viewport; `
          + "divide browser_capture pixels by its devicePixelRatio, or pass xRatio/yRatio");
      }
      return value;
    };
    const px = point(step.x, step.xRatio, "x"), py = point(step.y, step.yRatio, "y");
    if (action !== "wheel" && action !== "move" && (px === undefined || py === undefined)) {
      throw new Error(`mouse ${action} requires x and y, or xRatio and yRatio`);
    }
    const human = step.human !== false;
    const hoverMs = Math.min(2000, Math.max(0, step.hoverMs ?? 70));
    const holdMs = Math.min(2000, Math.max(0, step.holdMs ?? 90));
    const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
    const glide = async (tx, ty) => {
      const from = this.pointerAt.get(ref) || {
        x: Math.min(Math.max(tx - 46, 0), viewport.width || tx),
        y: Math.min(Math.max(ty - 30, 0), viewport.height || ty),
      };
      const distance = Math.hypot(tx - from.x, ty - from.y);
      const steps = human ? Math.max(6, Math.min(40, Math.round(distance / 14))) : 1;
      await page.mouse.move(tx, ty, { steps });
      this.pointerAt.set(ref, { x: tx, y: ty });
    };
    const press = async () => {
      await page.mouse.down({ button });
      if (human) await wait(holdMs);
      await page.mouse.up({ button });
      checkpoint(signal);
    };

    if (action === "move") await glide(px ?? 0, py ?? 0);
    else if (action === "wheel") {
      if (px !== undefined) await glide(px, py);
      await page.mouse.wheel(0, step.amount || 600);
    } else if (action === "drag") {
      if (step.toX === undefined && step.toXRatio === undefined && step.toRatioX === undefined) {
        throw new Error("mouse drag requires toX and toY, or toXRatio and toYRatio");
      }
      const toX = point(step.toX, step.toXRatio ?? step.toRatioX, "x");
      const toY = point(step.toY, step.toYRatio ?? step.toRatioY, "y");
      if (toX === undefined || toY === undefined) {
        throw new Error("mouse drag requires toX and toY, or toXRatio and toYRatio");
      }
      await glide(px, py);
      if (human) await wait(hoverMs);
      await page.mouse.down({ button });
      try {
        // A long-press drag: hold still first, because drag handlers that arm on a timer never
        // see a drag that starts moving immediately.
        const pressMs = Math.min(3000, Math.max(0, step.pressMs ?? 0));
        if (pressMs) await wait(pressMs);
        const duration = Math.min(10000, Math.max(60, step.durationMs || 400));
        if (!human || step.easing === "linear") {
          const steps = Math.max(4, Math.min(40, Math.round(duration / 40)));
          await page.mouse.move(toX, toY, { steps });
        } else {
          // People accelerate away from the press point and decelerate into the drop point, so
          // the intermediate positions are spread over an ease-in-out curve rather than evenly.
          // Drag handlers that watch velocity (inertial scrolling, slider snapping) need that.
          const segments = Math.max(6, Math.min(40, Math.round(duration / 40)));
          const pause = Math.max(4, Math.round(duration / segments));
          for (let index = 1; index <= segments; index++) {
            checkpoint(signal);
            const progress = index / segments;
            const eased = progress < 0.5 ? 2 * progress * progress : 1 - ((-2 * progress + 2) ** 2) / 2;
            await page.mouse.move(px + (toX - px) * eased, py + (toY - py) * eased);
            if (index < segments) await wait(pause);
          }
        }
        if (human) await wait(Math.min(400, holdMs));
      } finally { await page.mouse.up({ button }); }
      this.pointerAt.set(ref, { x: toX, y: toY });
    } else if (action === "double_click") {
      await glide(px, py);
      if (human) await wait(hoverMs);
      await press();
      await wait(human ? 60 : 0);
      await press();
    } else {
      await glide(px, py);
      if (human) await wait(hoverMs);
      await press();
    }
    checkpoint(signal);
  }

  locator(page, step) {
    if (step.ref) {
      if (!/^(?:f\d+)?e\d+$/.test(step.ref)) throw new Error("Use an element ref from the latest browser_read snapshot");
      return page.locator(`aria-ref=${step.ref}`);
    }
    if (step.selector) return step.frame ? page.frameLocator(step.frame).locator(step.selector) : page.locator(step.selector);
    throw new Error("Action requires ref or selector");
  }

  async act(ref, options, signal) {
    return this.serial(ref, () => this.withPage(ref, async (page, actionSignal, activity) => {
      signal = actionSignal;
      checkpoint(signal);
      const state = this.states.get(ref);
      let document = await this.document(page);
      if (!state || options.snapshot !== state.id || document.epoch !== state.epoch || document.url !== state.url) {
        throw new Error("Snapshot is stale. Call browser_read before acting; no actions were performed.");
      }
      if (state.refsAvailable === false && options.steps.some(step => step.ref || step.toRef)) throw new Error("Handle receipt withheld element refs. Read its cursor before using refs, or continue with selectors; old refs must not be reused.");
      const uploads = new Map();
      for (const [index, step] of options.steps.entries()) if (step.op === "upload" || step.op === "drop" && step.files) {
        if (!Array.isArray(step.files) || !step.files.length || step.files.length > 20) throw new Error("Upload requires 1-20 explicitly authorized absolute file paths");
        const files = [];
        for (const file of step.files) {
          if (typeof file !== "string" || !path.isAbsolute(file)) throw new Error("Upload paths must be absolute local files");
          const resolved = await realpath(file);
          if (!(await stat(resolved)).isFile()) throw new Error("Upload requires a regular file, not a directory");
          await access(resolved, constants.R_OK); files.push(resolved);
        }
        uploads.set(index, files);
      }
      const completed = [];
      const results = [];
      const extractCount = options.steps.filter(step => step.op === "extract").length;
      const extractLimit = Math.max(64, Math.floor(600 / Math.max(1, extractCount)));
      let failure;
      let navigated = false;
      let cancelled = false;
      let uncertainStep;
      // Invalidate before dispatch: cancellation must not leave an old snapshot reusable.
      this.states.delete(ref);
      this.receipts.delete(ref);
      for (let index = 0; index < options.steps.length; index++) {
        const step = options.steps[index];
        let attempted = false;
        try {
          checkpoint(signal);
          attempted = !["wait", "extract"].includes(step.op);
          if (step.op === "navigate") {
            if (!canControl(step.value)) throw new Error("Only HTTP/HTTPS or local file navigation is supported");
            await page.goto(step.value, { waitUntil: "domcontentloaded", signal });
          } else if (step.op === "back") await page.goBack({ waitUntil: "domcontentloaded", signal });
          else if (step.op === "forward") await page.goForward({ waitUntil: "domcontentloaded", signal });
          else if (step.op === "scroll") {
            await page.mouse.wheel(0, step.amount || 600);
          } else if (step.op === "mouse") {
            await this.pointer(page, step, signal, ref);
          } else {
            const target = this.locator(page, step);
            if (activity && !["wait", "extract", "upload"].includes(step.op)) await activity.pulse(target, signal).catch(() => {});
            if (step.op === "click") await target.click({ signal });
            else if (step.op === "drag") {
              const destination = this.locator(page, { ref: step.toRef, selector: step.toSelector, frame: step.frame });
              await target.dragTo(destination, { timeout: 8000, signal });
            }
            else if (step.op === "drop") {
              await target.drop({ ...(uploads.has(index) ? { files: uploads.get(index) } : {}), ...(step.data ? { data: step.data } : {}) }, { timeout: 8000, signal });
              if (uploads.has(index)) results.push({ index, files: uploads.get(index).map(file => clip(path.basename(file), 40)) });
            }
            else if (step.op === "upload") {
              const files = uploads.get(index);
              const input = await target.evaluate(element => element.localName === "input" && element.type === "file", undefined, { timeout: 8000, signal });
              if (input) await target.setInputFiles(files, { timeout: 8000, signal });
              else {
                // Cancel the waiter when its triggering click fails as well.
                const chooserController = new AbortController();
                const chooserSignal = signal ? AbortSignal.any([signal, chooserController.signal]) : chooserController.signal;
                const pending = page.waitForEvent("filechooser", { timeout: 8000, signal: chooserSignal });
                pending.catch(() => {});
                try {
                  await target.click({ timeout: 8000, signal });
                  const chooser = await pending;
                  checkpoint(signal);
                  await chooser.setFiles(files, { timeout: 8000, signal });
                } finally { chooserController.abort(); }
              }
              results.push({ index, files: files.map(file => clip(path.basename(file), 40)) });
            }
            else if (step.op === "fill") await target.fill(step.value, { signal });
            else if (step.op === "press") await target.press(step.value, { signal });
            else if (step.op === "select") await target.selectOption(step.value, { signal });
            else if (step.op === "check") await target.setChecked(step.checked ?? true, { signal });
            else if (step.op === "hover") await target.hover({ signal });
            else if (step.op === "wait") await target.waitFor({ state: step.state || "visible", timeout: step.timeout || 8000, signal });
            else if (step.op === "extract") {
              const fields = step.fields || ["text"];
              if (!fields.length || fields.some(field => !["text", "value", "href"].includes(field))) {
                throw new Error("Extract fields must be text, value or href");
              }
              const data = await target.evaluateAll((nodes, { fields, maxRows }) => {
                let truncated = false;
                const rows = nodes.slice(0, maxRows).map(node => {
                  const row = {};
                  for (const field of fields) {
                    const value = field === "text" ? (node.innerText ?? node.textContent ?? "").replace(/\s+/g, " ").trim()
                      : field === "href" ? (node.href ?? "")
                        : node.type === "password" ? "" : (node.value ?? "");
                    const text = String(value);
                    if (text.length > 200) truncated = true;
                    row[field] = text.slice(0, 200);
                  }
                  return row;
                });
                return { rows, totalRows: nodes.length, truncated };
              }, { fields, maxRows: Math.max(1, Math.min(20, step.maxRows || 10)) });
              results.push(boundedExtraction(index, data, extractLimit));
            }
            else throw new Error(`Unknown action: ${step.op}`);
          }
          completed.push({ index, op: step.op });
          checkpoint(signal);
          const after = await this.document(page);
          if (after.epoch !== document.epoch || after.url !== document.url) {
            const previous = new URL(document.url), current = new URL(after.url);
            const soft = after.epoch === document.epoch && current.origin === previous.origin && current.pathname === previous.pathname;
            // A query/hash update does not prove DOM refs are still valid.
            // Only selector-based observations or target-free navigation/scroll
            // can follow; a selector alone cannot prove a changed form is safe.
            if (soft && options.steps.slice(index + 1).every(next => !next.ref && ["wait", "extract", "scroll", "navigate", "back", "forward"].includes(next.op))) { document = after; }
            else { navigated = true; break; }
          }
        } catch (error) {
          cancelled = signal?.aborted === true;
          if ((cancelled || ["drag", "drop"].includes(step.op)) && attempted && completed.at(-1)?.index !== index) uncertainStep = index;
          failure = { index, op: step.op, error: clip(error.message || error, 200) };
          break;
        }
      }
      const result = boundAction({ tab: ref, completed, remaining: options.steps.length - completed.length,
        ...(results.length ? { results } : {}),
        ...(failure ? { failure, retry: "Read current state first. Do not repeat completed actions." } : {}),
        ...(navigated ? { navigated: true, stopped: "Navigation occurred; read the new page before remaining actions." } : {}),
        ...(cancelled ? { cancelled: true } : {}),
        ...(uncertainStep !== undefined ? { uncertainStep, mayHaveLateEffects: true } : {}) });
      if (cancelled) {
        this.receipts.set(ref, { snapshot: state.id, completed: completed.map(step => step.index), cancelled: true,
          ...(uncertainStep !== undefined ? { uncertainStep, mayHaveLateEffects: true } : {}) });
        return result;
      }
      if (options.observe === "summary") return result;
      try {
        const next = await this.snapshot(ref, page, {}, signal);
        if (options.observe === "handle") {
          next.refsAvailable = false;
          return boundAction({ ...result, snapshot: next.id, cursor: `${next.id}:0`, url: clip(next.url, 512), title: clip(next.title, 128), refs: "read_required" });
        }
        return boundedChunk(next, 0, 1600, result);
      } catch (error) {
        if (signal?.aborted) {
          this.states.delete(ref);
          this.receipts.set(ref, { snapshot: state.id, completed: completed.map(step => step.index), cancelled: true });
          return { ...result, cancelled: true };
        }
        return boundAction({ ...result, url: clip(page.url(), 256), readError: clip(error.message, 200) });
      }
    }, signal, true));
  }

  upload(ref, options, signal) {
    return this.act(ref, { snapshot: options.snapshot, observe: options.observe,
      steps: [{ op: "upload", ref: options.ref, selector: options.selector, frame: options.frame, files: options.files }] }, signal);
  }

  async network(ref, options = {}, signal) {
    return this.serial(ref, () => this.withPage(ref, async page => {
      checkpoint(signal);
      let capture = this.networks.get(ref);
      if (options.action === "start" && !capture?.active) {
        capture?.close();
        capture = new NetworkCapture(page);
        this.networks.set(ref, capture);
      }
      if (!capture) return { tab: ref, capturing: false, capturingSince: null, requests: [], note: "Not recording. Use action:start before the activity; past requests cannot be recovered." };
      if (options.action === "stop") capture.close();
      if (options.action === "clear") capture.clear();
      return { tab: ref, ...capture.result(options) };
    }, signal));
  }

  async capture(ref, options = {}, signal) {
    return this.serial(ref, () => this.withPage(ref, async page => {
      checkpoint(signal);
      await mkdir(this.artifactDir, { recursive: true });
      const output = path.join(this.artifactDir, `browser-${randomUUID()}.png`);
      await page.screenshot({ path: output, fullPage: options.fullPage === true, animations: "disabled", signal });
      // Keep the folder bounded: screenshots are only useful while the task is live.
      await pruneDirectory(this.artifactDir, { keep: CAPTURE_KEEP, maxAgeDays: CAPTURE_MAX_AGE_DAYS });
      checkpoint(signal);
      // The PNG is in device pixels; mouse actions take CSS pixels. Reporting the ratio and the
      // viewport here is what lets a caller turn "the button looks like it is at (944, 678)"
      // into coordinates it can actually click.

      // Let the browser finish inserting its own chrome (a debugger infobar appears when the
      // extension attaches and disappears again when it detaches) before measuring: a viewport
      // caught mid-animation would make every coordinate we hand out slightly wrong.
      const viewport = await this.settleViewport(page);
      if (viewport) this.viewports.set(ref, viewport);
      return { tab: ref, url: clip(page.url(), 512), path: output, mediaType: "image/png",
        fullPage: options.fullPage === true, ...(viewport ? { viewport } : {}) };
    }, signal));
  }
}
