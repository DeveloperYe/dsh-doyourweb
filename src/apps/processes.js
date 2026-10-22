import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash, randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import path from "node:path";
import { windowsInventory, usefulWindows } from "./windows.js";

export const runFile = promisify(execFile);

export class AppUnavailable extends Error {
  constructor() { super("Application exited or its window changed; stop looking and ask the user to open the window and select it with @ again"); this.code = "APP_WINDOW_UNAVAILABLE"; }
}

export async function processWindows({ signal } = {}) {
  if (process.platform === "win32") {
    const { stdout } = await runFile("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(windowsInventory, "utf16le").toString("base64")], { windowsHide: true, timeout: 10000, maxBuffer: 2 * 1024 * 1024, signal });
    const value = stdout.trim() ? JSON.parse(stdout.replace(/^\uFEFF/, "")) : [];
    return usefulWindows(Array.isArray(value) ? value : [value]);
  }
  throw new Error("Running-app inventory currently requires Windows; configure a desktop connector for this platform");
}

export async function findExecutable(command, extra = []) {
  if (!command || typeof command !== "string") return;
  const extensions = process.platform === "win32" && !path.extname(command) ? [".exe", ".cmd", ".bat", ""] : [""];
  const directories = path.isAbsolute(command) ? [""] : [...extra, ...(process.env.PATH || "").split(path.delimiter)];
  for (const directory of directories) for (const extension of extensions) {
    const file = path.resolve(directory, command + extension);
    try { if ((await stat(file)).isFile()) return file; } catch { /* Continue PATH search. */ }
  }
}

export class AppInventory {
  constructor({ inventory = processWindows } = {}) { this.inventory = inventory; this.runtime = randomUUID(); this.apps = new Map(); this.updated = 0; this.pending = undefined; }
  async list(query = "", signal, refresh = false) {
    signal?.throwIfAborted();
    if (refresh || Date.now() - this.updated > 2500) {
      if (!this.pending) this.pending = (async () => {
        const rows = await this.inventory({ signal }); const next = new Map();
        for (const row of rows.slice(0, 150)) {
          const identity = createHash("sha256").update(`${row.pid}:${row.windowId}:${row.started}:${row.path || row.name}`).digest("hex").slice(0, 24);
          const ref = `dsh-app://${this.runtime}/${identity}`;
          next.set(ref, { ...row, ref });
        }
        this.apps = next; this.updated = Date.now();
      })().finally(() => { this.pending = undefined; });
      await this.pending;
    }
    signal?.throwIfAborted();
    const needle = query.trim().toLowerCase().replace(/\.exe$/, "");
    return [...this.apps.values()].filter(app => !needle || `${app.name} ${app.product || ""} ${app.displayName || ""} ${app.title}`.toLowerCase().includes(needle)).slice(0, 60);
  }
  async resolve(ref, signal, { fresh = false } = {}) {
    signal?.throwIfAborted();
    if (!this.apps.has(ref)) throw new AppUnavailable();
    await this.list("", signal, fresh); const app = this.apps.get(ref);
    if (!app) throw new AppUnavailable();
    return app;
  }
}

export const appRefs = text => [...new Set(text.match(/dsh-app:\/\/[a-f0-9-]{36}\/[a-f0-9]{24}/gi) || [])];
